import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import type { ReadStream } from 'node:tty';

const START = '\x1b[200~';
const END = '\x1b[201~';
const SEND = ['\x1b[13;5u', '\x1b[27;5;13~'];
const MARKERS = [START, END, ...SEND];
const MARKER_PREFIXES = MARKERS.flatMap((marker) => Array.from({ length: marker.length - 1 }, (_, i) => marker.slice(0, i + 1)));

/** Keep readline's single-line editing; accumulate completed lines until Ctrl+Enter. */
export class TerminalInput extends PassThrough {
  readonly isTTY = true;
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private paste: string[] | undefined;
  private pasteAllowed = false;
  private draft: string[] = [];
  private submitting = false;
  private lastCR = 0;
  private escapeTimer?: ReturnType<typeof setTimeout>;
  private wasRaw: boolean;
  private wasFlowing: boolean | null;
  constructor(private source: ReadStream, private output: NodeJS.WriteStream, private isMain: () => boolean) {
    super();
    this.wasRaw = !!source.isRaw;
    this.wasFlowing = source.readableFlowing;
    source.on('data', this.onData);
    source.on('end', this.onEnd);
    output.write('\x1b[?2004h');
  }
  get isRaw() { return this.source.isRaw; }
  setRawMode(mode: boolean): this { this.source.setRawMode(mode); return this; }
  private onEnd = () => { this.end(); };
  private onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    // Legacy terminals may paste an unframed multiline block in a single data event.
    if (!this.pending && !this.paste && !MARKERS.some((marker) => text.includes(marker)) && !MARKER_PREFIXES.some((prefix) => text.endsWith(prefix)) && text.length > 1 && /[\r\n]/.test(text) && /[^\r\n]/.test(text)) {
      this.insertPaste(text, this.isMain());
      return;
    }
    this.pending += text;
    this.drain();
  };
  private insertPaste(text: string, allowed: boolean): void {
    if (!allowed || !this.isMain()) return;
    const safe = stripVTControlCharacters(text).replace(/\r\n|\r/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    // CR goes through readline as a completed draft line, never as a submission.
    this.write(safe.replace(/\n/g, '\r'));
  }
  private submit(): void {
    if (!this.isMain()) { this.write('\r'); return; }
    this.submitting = true;
    try { this.write('\r'); } finally { this.submitting = false; }
  }
  private drain(): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    while (this.pending) {
      if (this.paste) {
        const end = this.pending.indexOf(END);
        const cancel = this.pending.indexOf('\x03');
        if (cancel >= 0 && (end < 0 || cancel < end)) {
          this.pending = this.pending.slice(cancel + 1);
          this.paste = undefined; this.cancelDraft(); this.write('\x03');
          continue;
        }
        if (end >= 0) {
          this.paste.push(this.pending.slice(0, end));
          const text = this.paste.join('');
          this.paste = undefined;
          this.pending = this.pending.slice(end + END.length);
          this.insertPaste(text, this.pasteAllowed);
          continue;
        }
        const keep = Math.min(END.length - 1, this.pending.length);
        this.paste.push(this.pending.slice(0, this.pending.length - keep));
        this.pending = this.pending.slice(this.pending.length - keep);
        return;
      }
      const marker = MARKERS.find((m) => this.pending.startsWith(m));
      if (marker) {
        this.pending = this.pending.slice(marker.length);
        this.lastCR = 0;
        if (marker === START) { this.paste = []; this.pasteAllowed = this.isMain(); }
        else if (SEND.includes(marker)) this.submit();
        continue;
      }
      if (MARKERS.some((m) => m.startsWith(this.pending))) {
        this.escapeTimer = setTimeout(() => { const text = this.pending; this.pending = ''; this.write(text); }, 500);
        return;
      }
      const char = String.fromCodePoint(this.pending.codePointAt(0)!);
      this.pending = this.pending.slice(char.length);
      if (char === '\r') { this.lastCR = Date.now(); this.write('\r'); }
      else if (char === '\n') {
        if (!this.lastCR || Date.now() - this.lastCR > 20) this.submit();
        this.lastCR = 0;
      } else { this.lastCR = 0; this.write(char); }
    }
  }
  acceptLine(line: string): string | undefined {
    if (!this.isMain()) return line;
    if (!this.submitting) { this.draft.push(line); return undefined; }
    const message = [...this.draft, line].join('\n');
    this.draft = [];
    return message;
  }
  cancelDraft(): void { this.draft = []; }
  dispose(): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.source.off('data', this.onData); this.source.off('end', this.onEnd);
    this.source.setRawMode(this.wasRaw);
    if (this.wasFlowing !== true) this.source.pause();
    this.output.write('\x1b[?2004l');
    this.destroy();
  }
}
