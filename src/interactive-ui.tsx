import type { InterruptKey } from './config.js';
import { InkInput } from './ink-input.js';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import wrapAnsi from 'wrap-ansi';
import React, { useEffect, useReducer, useState, useMemo } from 'react';
import { Box, Text, render, useInput, usePaste, type Key } from 'ink';

const clean = (text: string) => stripVTControlCharacters(text).replace(/\r\n|\r/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
type Question = { prompt: string; draft: string; resolve: (value: string | null) => void; cleanup: () => void };

/** Input stays mounted during a turn. Only explicit submissions enter the FIFO. */
export class InteractiveInput extends EventEmitter {
  draft = '';
  cursor = 0;
  transcript = '';
  queue: string[] = [];
  panelVisible = true;
  scroll = 0;
  maxScroll = 0;
  scrollTranscript(rows: number) {
    this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + rows));
    this.changed();
  }
  statusScroll = 0;
  statusFocused = false;
  closed = false;
  prompt = '> ';
  status: () => string[] = () => [];
  busy: () => boolean = () => false;
  onInterrupt = () => {};
  onCycle = () => {};
  onInterruptPrompt = () => {};
  enterAction: 'newline' | 'queue' | 'interrupt' = 'newline';
  ctrlEnterAction: 'newline' | 'queue' | 'interrupt' = 'queue';
  shiftEnterAction: 'newline' | 'queue' | 'interrupt' = 'interrupt';
  slashEnterSubmit = true;
  interruptKey?: InterruptKey;
  private waiter?: (value: string | null) => void;
  private questions: Question[] = [];
  get question() { return this.questions[0]; }
  changed() { this.emit('change'); }
  write = (text: string) => { this.transcript = (this.transcript + clean(text)).slice(-200_000); this.changed(); };
  insert(text: string, pasted = false) {
    // Pasted text must never answer an approval question.
    if (pasted && this.question) return;
    const value = clean(text);
    if (this.question) this.question.draft += value.replace(/\n/g, '');
    else { this.draft = this.draft.slice(0, this.cursor) + value + this.draft.slice(this.cursor); this.cursor += value.length; }
    this.changed();
  }
  submit(interrupt = false) {
    if (this.closed) return;
    if (this.question) { const q = this.questions.shift()!; q.cleanup(); q.resolve(q.draft); this.changed(); return; }
    const value = this.draft; this.draft = ''; this.cursor = 0;
    if (!value.trim()) { this.changed(); return; }
    if (value.trim() === '/status') { this.panelVisible = !this.panelVisible; this.changed(); return; }
    this.write(`\n> ${value}\n`);
    if (interrupt) this.onInterruptPrompt();
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve(value); }
    else { if (interrupt) this.queue.unshift(value); else this.queue.push(value); this.write(`(${interrupt ? '현재 작업 중단 요청 · 우선 실행' : '전송 대기'} ${this.queue.length}개 — 현재 작업이 끝나면 실행해요)\n`); }
    this.changed();
  }
  readLine(prompt: string, signal?: AbortSignal): Promise<string | null> {
    this.prompt = clean(prompt); this.changed();
    if (signal) return this.ask(prompt, signal);
    if (this.closed) return Promise.resolve(null);
    if (this.queue.length) { const value = this.queue.shift()!; this.changed(); return Promise.resolve(value); }
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => { this.waiter = resolve; });
  }
  ask(prompt: string, signal?: AbortSignal): Promise<string | null> {
    if (this.closed || signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const q: Question = { prompt: clean(prompt), draft: '', resolve, cleanup: () => signal?.removeEventListener('abort', abort) };
      const abort = () => { const index = this.questions.indexOf(q); if (index < 0) return; this.questions.splice(index, 1); q.cleanup(); resolve(null); this.changed(); };
      this.questions.push(q); signal?.addEventListener('abort', abort, { once: true }); this.changed();
      if (signal?.aborted) abort();
    });
  }
  key(input: string, key: Partial<Key>) {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'c') { this.onInterrupt(); return; }
    if (key.ctrl && input === 'd') { this.onInterruptPrompt(); this.close(); return; }
    if (key.tab && key.shift && !this.question) { this.onCycle(); return; }
    if (key.tab && !this.question) { this.statusFocused = !this.statusFocused; this.changed(); return; }
    if (key.pageUp || key.pageDown) { if (this.statusFocused) this.statusScroll = Math.max(0, Math.min(this.status().length - 1, this.statusScroll + (key.pageUp ? -5 : 5))); else { this.scrollTranscript(key.pageUp ? 10 : -10); return; } this.changed(); return; }
    if (this.interruptKey && key.ctrl && !key.shift && !key.meta && !key.super &&
        this.interruptKey === `ctrl+${input}`) {
      if (!this.question && key.eventType !== 'repeat') this.submit(true);
      return;
    }
    const enter = key.return || input === '\n' || (key.ctrl && input === 'j');
    if (enter) {
      if (this.question) this.submit();
      else {
        const plain = key.return && !key.ctrl && !key.shift;
        const action = plain && this.slashEnterSubmit && this.draft.trim().startsWith('/') && !this.draft.includes('\n') ? 'queue' : plain ? this.enterAction : key.shift ? this.shiftEnterAction : this.ctrlEnterAction;
        if (action === 'newline') this.insert('\n'); else this.submit(action === 'interrupt');
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (this.question) this.question.draft = this.question.draft.slice(0, -1);
      else if (key.delete) this.draft = this.draft.slice(0, this.cursor) + this.draft.slice(this.cursor + ([...this.draft.slice(this.cursor)][0]?.length ?? 0));
      else if (this.cursor > 0) { const previous = [...this.draft.slice(0, this.cursor)].at(-1)!; this.draft = this.draft.slice(0, this.cursor - previous.length) + this.draft.slice(this.cursor); this.cursor -= previous.length; }
      this.changed(); return;
    }
    if (!this.question && (key.leftArrow || key.rightArrow || key.home || key.end)) {
      if (key.home) this.cursor = 0; else if (key.end) this.cursor = this.draft.length;
      else if (key.leftArrow) this.cursor -= [...this.draft.slice(0, this.cursor)].at(-1)?.length ?? 0;
      else this.cursor += [...this.draft.slice(this.cursor)][0]?.length ?? 0;
      this.changed(); return;
    }
    if (!key.ctrl && !key.meta && !key.escape && !key.tab) this.insert(input);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.queue = []; this.waiter?.(null); this.waiter = undefined;
    for (const q of this.questions.splice(0)) { q.cleanup(); q.resolve(null); }
    this.changed();
  }
  cancelDraft() { this.draft = ''; this.cursor = 0; this.changed(); }
}

function Screen({ input }: { input: InteractiveInput }) {
  const [, refresh] = useReducer(n => n + 1, 0);
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  useEffect(() => { const change = () => refresh(); input.on('change', change); const timer = setInterval(change, 1000); process.stdout.on('resize', change); return () => { input.off('change', change); clearInterval(timer); process.stdout.off('resize', change); }; }, [input]);
  useInput((value, key) => input.key(value, key));
  usePaste(value => input.insert(value, true));
  // Keep the final terminal column empty. Writing into it can trigger
  // terminal autowrap and shift the rows Ink clears on the next frame.
  const width = Math.max(1, (process.stdout.columns ?? 100) - 1);
  const height = Math.max(12, process.stdout.rows ?? 30);
  const side = input.panelVisible && width >= 90;
  const paneWidth = side ? width - 42 : width;
  const questionRows = input.question ? wrapAnsi(input.question.prompt, Math.max(1, paneWidth - 2), { hard: true }).split('\n').length : 1;
  const inputLines = input.question ? Math.min(10, questionRows + 1) : Math.min(7, Math.max(2, wrapAnsi(input.draft, Math.max(1, paneWidth - 2), { hard: true }).split('\n').length + 1));
  const transcriptRows = Math.max(3, height - inputLines - (side || !input.panelVisible ? 6 : 11));
  const history = useMemo(() => wrapAnsi(input.transcript, Math.max(1, paneWidth), { hard: true }).split('\n'), [input.transcript, paneWidth]);
  input.maxScroll = Math.max(0, history.length - transcriptRows);
  const end = history.length - Math.min(input.scroll, input.maxScroll);
  const visible = history.slice(Math.max(0, end - transcriptRows), end).join('\n');
  const draft = input.question ? input.question.draft : input.draft.slice(0, input.cursor) + '▌' + input.draft.slice(input.cursor);
  const wrappedDraft = wrapAnsi(draft, Math.max(1, paneWidth - 2), { hard: true });
  const cursorLine = wrapAnsi(input.draft.slice(0, input.cursor), Math.max(1, paneWidth - 2), { hard: true }).split('\n').length - 1;
  const draftStart = input.question ? 0 : Math.max(0, cursorLine - 3);
  if (!ready) return <Text>CVP UI 준비 중…</Text>;
  return <Box flexDirection="column" width={width} height={height - 1} overflow="hidden">
    <Text bold color="cyan" wrap="truncate-end">CVP CLI · {input.busy() ? '작업 중' : '입력 가능'} · 전송 대기 {input.queue.length}개</Text>
    <Box flexGrow={1} flexDirection={side ? 'row' : 'column'}>
      <Box flexDirection="column" flexGrow={1} flexShrink={0} width={side ? width - 42 : width} height={side || !input.panelVisible ? height - 3 : height - 8}>
        <Box flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden"><Text wrap="wrap">{visible}</Text></Box>
        <Box borderStyle="round" borderColor={input.question ? 'yellow' : 'green'} flexDirection="column" flexShrink={0} height={inputLines + 2} overflow="hidden">
          <Text color={input.question ? 'yellow' : 'green'}>{input.question ? wrapAnsi(input.question.prompt, Math.max(1, paneWidth - 2), { hard: true }).split('\n').slice(-(inputLines - 1)).join('\n') : input.prompt}</Text>
          <Text>{wrappedDraft.split('\n').slice(draftStart, draftStart + 6).join('\n')}</Text>
        </Box>
      </Box>
      {input.panelVisible && <Box width={side ? 42 : width} height={side ? undefined : 5} borderStyle="round" borderColor={input.statusFocused ? "cyan" : "gray"} flexDirection="column" flexShrink={0} overflow="hidden"><Text bold>상태 · Tab/PgUp/PgDn 이동</Text><Text wrap="wrap">{wrapAnsi(input.status().map(clean).join('\n'), side ? 40 : Math.max(1, width - 2), { hard: true }).split('\n').slice(input.statusScroll).join('\n')}</Text></Box>}
    </Box>
    <Text dimColor wrap="truncate-end">Enter {input.enterAction} · Ctrl+Enter {input.ctrlEnterAction} · Shift+Enter {input.shiftEnterAction}{input.interruptKey ? ` · ${input.interruptKey} interrupt` : ''} · 휠/PgUp/PgDn 기록 · Shift+드래그 선택</Text>
  </Box>;
}

export function startInteractiveUi(input: InteractiveInput) {
  const stdin = new InkInput(process.stdin, rows => input.scrollTranscript(rows));
  const isWindowsTerminal = process.platform === 'win32' && Boolean(process.env.WT_SESSION);
  const instance = render(<Screen input={input} />, {
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    maxFps: 20,
    kittyKeyboard: { mode: isWindowsTerminal ? 'enabled' : 'auto' },
  });
  process.stdout.write('\x1b[?1006h\x1b[?1000h');
  const end = () => input.close();
  process.stdin.on('end', end);
  return () => {
    process.stdin.off('end', end);
    input.close();
    try {
      process.stdout.write('\x1b[?1000l\x1b[?1006l');
      instance.unmount();
    } finally {
      stdin.dispose();
    }
  };
}
