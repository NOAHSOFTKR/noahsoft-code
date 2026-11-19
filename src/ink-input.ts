import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ReadStream } from 'node:tty';

const START = '\x1b[200~', END = '\x1b[201~';
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
  constructor(private source: ReadStream) {
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
      const markers = this.pasted ? [END] : [START, ...LEGACY];
      const marker = markers.find(value => this.pending.startsWith(value));
      if (marker) {
        this.pending = this.pending.slice(marker.length);
        if (marker === START) this.pasted = true;
        else if (marker === END) this.pasted = false;
        out += LEGACY.includes(marker) ? `\x1b[13;${marker[5]}u` : marker;
      } else if (markers.some(value => value.startsWith(this.pending))) break;
      else { const char = String.fromCodePoint(this.pending.codePointAt(0)!); out += char; this.pending = this.pending.slice(char.length); }
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
