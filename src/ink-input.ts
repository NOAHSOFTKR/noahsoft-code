import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ReadStream } from 'node:tty';

const START = '\x1b[200~', END = '\x1b[201~';
// Normalize control characters before Ink groups adjacent input into one event.
const ALTERNATE_KEYS: Readonly<Record<string, string>> = {
  '\x07': '\x1b[103;5u',
  '\x0b': '\x1b[107;5u',
  '\x15': '\x1b[117;5u',
};
const SGR_MOUSE = /^\x1b\[<(\d{1,5});\d{1,5};\d{1,5}([Mm])/;
const SGR_MOUSE_PREFIX = /^\x1b\[<\d{0,5}(?:;\d{0,5}){0,2}$/;
const LEGACY = Array.from({ length: 7 }, (_, i) => `\x1b[27;${i + 2};13~`);
/** Normalize xterm modifyOtherKeys Enter for Ink, preserving literal bracketed paste. */
export class InkInput extends PassThrough {
  readonly isTTY = true;
  private pending = '';
  private pasted = false;
  private decoder = new StringDecoder('utf8');
  private timer?: NodeJS.Timeout;
  private raw: boolean;
  private flowing: boolean | null;
  constructor(private source: ReadStream, private onWheel?: (rows: number) => void) {
    super(); this.raw = !!source.isRaw; this.flowing = source.readableFlowing;
    source.on('data', this.data); source.on('end', this.finish);
  }
  get isRaw() { return this.source.isRaw; }
  setRawMode(value: boolean) { this.source.setRawMode(value); return this; }
  private data = (chunk: Buffer | string) => {
    if (this.timer) clearTimeout(this.timer);
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let out = '';
    while (this.pending) {
      if (!this.pasted && this.onWheel && this.pending.startsWith('\x1b[<')) {
        const mouse = SGR_MOUSE.exec(this.pending);
        if (mouse) {
          this.pending = this.pending.slice(mouse[0].length);
          const button = Number(mouse[1]) & ~28;
          if (mouse[2] === 'M' && (button === 64 || button === 65)) {
            this.onWheel(button === 64 ? 3 : -3);
          }
          continue;
        }
        if (SGR_MOUSE_PREFIX.test(this.pending)) break;
      }
      const markers = this.pasted ? [END] : [START, ...LEGACY];
      const marker = markers.find(value => this.pending.startsWith(value));
      if (marker) {
        this.pending = this.pending.slice(marker.length);
        if (marker === START) this.pasted = true;
        else if (marker === END) this.pasted = false;
        out += LEGACY.includes(marker) ? `\x1b[13;${marker[5]}u` : marker;
      } else if (markers.some(value => value.startsWith(this.pending))) break;
      else { const char = String.fromCodePoint(this.pending.codePointAt(0)!); out += this.pasted ? char : (ALTERNATE_KEYS[char] ?? char); this.pending = this.pending.slice(char.length); }
    }
    if (out) this.write(out);
    if (this.pending) this.timer = setTimeout(() => { this.write(this.pending); this.pending = ''; }, 100);
  };
  private finish = () => { if (this.timer) clearTimeout(this.timer); this.pending += this.decoder.end(); if (this.pending) this.write(this.pending); this.pending = ''; this.end(); };
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.source.off('data', this.data); this.source.off('end', this.finish);
    this.source.setRawMode(this.raw); if (this.flowing !== true) this.source.pause(); this.destroy();
  }
}
