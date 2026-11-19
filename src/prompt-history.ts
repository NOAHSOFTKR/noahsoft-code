import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cvpHome } from './config.js';

export const PROMPT_HISTORY_LIMIT = 100;
const MAX_BYTES = 1024 * 1024;

export class PromptHistory {
  private readonly file: string;

  constructor(cwd: string) {
    const directory = path.resolve(cwd);
    const key = createHash('sha256').update(process.platform === 'win32' ? directory.toLowerCase() : directory).digest('hex');
    this.file = path.join(cvpHome(), 'prompt-history', `${key}.json`);
  }

  load(): string[] {
    try {
      if (fs.statSync(this.file).size > MAX_BYTES) return [];
      const entries: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(entries)) return [];
      return entries.filter((entry): entry is string =>
        typeof entry === 'string' && !!entry.trim() && !entry.trimStart().startsWith('/'),
      ).slice(-PROMPT_HISTORY_LIMIT);
    } catch {
      return [];
    }
  }

  append(prompt: string): void {
    const entries = this.load();
    if (entries.at(-1) === prompt) return;
    const latest = JSON.stringify(prompt);
    let bytes = Buffer.byteLength(latest) + 2;
    if (bytes > MAX_BYTES) return;

    const encoded = [latest];
    for (const entry of entries.slice(-(PROMPT_HISTORY_LIMIT - 1)).reverse()) {
      const item = JSON.stringify(entry);
      bytes += Buffer.byteLength(item) + 1;
      if (bytes > MAX_BYTES) break;
      encoded.push(item);
    }
    const text = `[${encoded.reverse().join(',')}]`;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } catch {
      // History is optional. A write failure must never block prompt submission.
      try { fs.unlinkSync(temporary); } catch { /* no temporary file to remove */ }
    }
  }
}
