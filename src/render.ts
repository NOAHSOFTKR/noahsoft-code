import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';

let markedInstance: Marked | undefined;

function getMarked(): Marked {
  if (!markedInstance) {
    markedInstance = new Marked();
    const width = Math.max(40, Math.min(process.stdout.columns ?? 100, 120) - 2);
    // marked-terminal 은 코드 블록을 cli-highlight 로 구문 강조한다
    markedInstance.use(markedTerminal({ width, reflowText: false, tab: 2 }) as never);
  }
  return markedInstance;
}

export function renderMarkdown(md: string): string {
  try {
    const out = getMarked().parse(md, { async: false }) as string;
    return out.replace(/\n+$/, '\n');
  } catch {
    return md;
  }
}

const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * 스트리밍 Markdown 렌더러.
 * 토큰이 들어오는 즉시 출력하되, 완결된 블록(빈 줄로 끝난 문단, 닫힌 코드 펜스) 단위로
 * Markdown 을 렌더링해서 코드 블록 구문 강조가 깨지지 않게 한다.
 * raw 모드에서는 텍스트를 그대로 흘려보낸다.
 */
export class MarkdownStream {
  private buf = '';
  private wroteAny = false;
  constructor(
    private write: (s: string) => void,
    private raw = false,
  ) {}

  push(text: string): void {
    if (this.raw) {
      this.write(text);
      this.wroteAny = true;
      return;
    }
    this.buf += text;
    this.drain(false);
  }

  /** 블록 종료 시 남은 내용을 모두 출력 */
  flush(): void {
    if (this.raw) {
      if (this.wroteAny) this.write('\n');
      this.wroteAny = false;
      return;
    }
    this.drain(true);
  }

  private drain(final: boolean): void {
    const lines = this.buf.split('\n');
    // 마지막 원소는 아직 줄바꿈이 오지 않은 미완성 줄
    const incomplete = final ? '' : (lines.pop() ?? '');
    let inFence = false;
    let cut = -1; // 렌더링 가능한 마지막 줄 인덱스
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (FENCE.test(line)) {
        inFence = !inFence;
        if (!inFence) cut = i; // 코드 블록이 닫힘
        continue;
      }
      if (!inFence && line.trim() === '') cut = i;
    }
    if (final) cut = lines.length - 1;
    if (cut < 0) return;
    const ready = lines.slice(0, cut + 1).join('\n');
    const rest = lines.slice(cut + 1);
    if (!final) rest.push(incomplete);
    this.buf = rest.join('\n');
    if (ready.trim()) {
      this.write(renderMarkdown(ready));
      this.wroteAny = true;
    }
  }
}

export const ui = {
  dim: (s: string) => chalk.dim(s),
  err: (s: string) => chalk.red(s),
  warn: (s: string) => chalk.yellow(s),
  ok: (s: string) => chalk.green(s),
  head: (s: string) => chalk.bold.cyan(s),
  tool: (s: string) => chalk.magenta(s),
};

/** 단순 스피너(TTY 에서만) */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private static frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  constructor(private stream: NodeJS.WriteStream = process.stdout) {}
  start(label: string): void {
    if (!this.stream.isTTY || this.timer) return;
    this.timer = setInterval(() => {
      this.stream.write(`\r${chalk.cyan(Spinner.frames[this.frame++ % Spinner.frames.length])} ${chalk.dim(label)}\x1b[K`);
    }, 80);
  }
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream.write('\r\x1b[K');
  }
}
