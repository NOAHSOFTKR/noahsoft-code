import { PROMPT_HISTORY_LIMIT, type PromptHistory } from './prompt-history.js';
import { layoutDraft } from './draft-layout.js';
import { modelCompletion } from './model-input.js';
import type { InterruptKey } from './config.js';
import { InkInput } from './ink-input.js';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import wrapAnsi from 'wrap-ansi';
import React, { useEffect, useReducer, useState, useMemo } from 'react';
import { Box, Text, render, useInput, usePaste, type Key } from 'ink';

const clean = (text: string) => stripVTControlCharacters(text).replace(/\r\n|\r/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const WORKSPACE_ACTIONS = [
  '대기 요청 보기·회수',
  '프롬프트 기록 검색',
  '현재 초안 임시 보관',
  '임시 보관한 초안 복구',
  '모델 선택',
  '상태 상세 / 요약 전환',
  '대화 기록 크게 보기',
  '기존 화면 모드로 돌아가기',
] as const;

type WorkspaceView = 'menu' | 'queue' | 'history' | 'models' | 'transcript';
type WorkspaceOverlay = {
  view: WorkspaceView;
  index: number;
  query: string;
  queue?: { revision: number; entries: string[] };
  notice?: string;
  loading?: boolean;
};

type Question = { prompt: string; draft: string; resolve: (value: string | null) => void; cleanup: () => void };

/** Input stays mounted during a turn. Only explicit submissions enter the FIFO. */
export class InteractiveInput extends EventEmitter {
  draft = '';
  draftWidth = Infinity;
  cursor = 0;
  transcript = '';
  queue: string[] = [];
  panelVisible = true;
  modelIds: string[] = [];
  enhanced = false;
  detailedStatus = false;
  workspace?: WorkspaceOverlay;
  summaryStatus: () => string[] = () => [];
  currentModel: () => string = () => '';
  loadModelIds: () => Promise<string[]> = async () => [];
  recentModels: string[] = [];
  displayStatus() {
    return this.enhanced && !this.detailedStatus ? this.summaryStatus() : this.status();
  }
  private queueRevision = 0;
  transcriptViewWidth = 80;
  transcriptViewRows = 18;

  transcriptViewLines() {
    return wrapAnsi(this.transcript, this.transcriptViewWidth, { hard: true }).split('\n');
  }
  private stashedDrafts: string[] = [];

  private stashDraft() {
    if (!this.draft || this.stashedDrafts.at(-1) === this.draft) return;
    this.stashedDrafts.push(this.draft);
    if (this.stashedDrafts.length > 10) this.stashedDrafts.shift();
  }

  private useDraft(value: string) {
    this.stashDraft();
    this.cancelDraft(false);
    this.draft = value;
    this.cursor = value.length;
    this.workspace = undefined;
    this.changed();
  }

  openWorkspace(view: WorkspaceView = 'menu') {
    if (!this.enhanced || this.question || this.closed) return;
    const overlay: WorkspaceOverlay = { view, index: 0, query: '', loading: view === 'models' };
    if (view === 'queue') overlay.queue = { revision: this.queueRevision, entries: [...this.queue] };
    this.workspace = overlay;
    this.changed();
    if (view === 'models') {
      void this.loadModelIds().then(ids => {
        if (this.workspace !== overlay) return;
        const selected = this.workspaceEntries()[overlay.index];
        this.modelIds = [...new Set([...this.modelIds, ...ids])];
        overlay.index = Math.max(0, this.workspaceEntries().indexOf(selected));
        overlay.loading = false;
        this.changed();
      }, () => {
        if (this.workspace !== overlay) return;
        overlay.loading = false;
        overlay.notice = '모델 목록 조회 실패 · 알려진 모델만 표시합니다';
        this.changed();
      });
    }
  }

  workspaceEntries(): readonly string[] {
    const overlay = this.workspace;
    if (!overlay) return [];
    const query = overlay.query.toLowerCase();
    switch (overlay.view) {
      case 'menu': return WORKSPACE_ACTIONS;
      case 'queue': return overlay.queue?.entries ?? [];
      case 'history': return this.promptHistory.filter(item => item.toLowerCase().includes(query)).reverse();
      case 'models': return [...new Set([this.currentModel(), ...this.recentModels, ...this.modelIds])]
        .filter(id => /^[\p{L}\p{N}_.:/-]+$/u.test(id) && id.toLowerCase().includes(query));
      case 'transcript': return [];
    }
  }

  private handleWorkspaceKey(value: string, key: Partial<Key>) {
    const overlay = this.workspace!;
    const modified = key.ctrl || key.shift || key.meta || key.super || key.hyper;
    if (modified) return;
    if (key.escape) {
      if (overlay.view === 'menu') { this.workspace = undefined; this.changed(); }
      else this.openWorkspace();
      return;
    }
    if (overlay.view === 'transcript') {
      if (key.upArrow || key.downArrow) this.scrollTranscript(key.upArrow ? 1 : -1);
      if (key.pageUp || key.pageDown) this.scrollTranscript((key.pageUp ? 1 : -1) * this.transcriptViewRows);
      return;
    }
    const entries = this.workspaceEntries();
    if (key.upArrow || key.downArrow) {
      overlay.index = Math.max(0, Math.min(entries.length - 1, overlay.index + (key.upArrow ? -1 : 1)));
    } else if (overlay.view === 'queue' && (key.return || key.delete)) {
      const snapshot = overlay.queue!;
      if (snapshot.revision !== this.queueRevision) {
        this.openWorkspace('queue');
        this.workspace!.notice = '대기열이 바뀌었어요. 다시 선택해 주세요.';
      } else if (overlay.index < snapshot.entries.length) {
        const [entry] = this.queue.splice(overlay.index, 1);
        this.queueRevision++;
        if (key.return) this.useDraft(entry);
        else this.openWorkspace('queue');
      }
    } else if (key.return && overlay.view === 'menu') {
      switch (overlay.index) {
        case 0: this.openWorkspace('queue'); break;
        case 1: this.openWorkspace('history'); break;
        case 2:
          this.stashDraft();
          this.cancelDraft(false, false);
          this.workspace = undefined;
          break;
        case 3: {
          const restored = this.stashedDrafts.pop();
          if (restored !== undefined) this.useDraft(restored);
          else overlay.notice = '보관한 초안이 없어요.';
          break;
        }
        case 4: this.openWorkspace('models'); break;
        case 5:
          this.detailedStatus = !this.detailedStatus;
          this.panelVisible = true;
          this.statusScroll = 0;
          this.workspace = undefined;
          break;
        case 6: this.openWorkspace('transcript'); break;
        case 7: this.toggleWorkspaceMode(); break;
      }
    } else if (key.return && entries[overlay.index] !== undefined) {
      const item = entries[overlay.index];
      if (overlay.view === 'history') this.useDraft(item);
      if (overlay.view === 'models') {
        this.workspace = undefined;
        if (item !== this.currentModel()) this.dispatch(`/model ${item}`, false);
      }
    } else if (overlay.view === 'history' || overlay.view === 'models') {
      if (key.backspace || key.delete) {
        overlay.query = [...overlay.query].slice(0, -1).join('');
      } else if (!key.ctrl && !key.meta && !key.tab) {
        overlay.query = (overlay.query + clean(value).replace(/\n/g, '')).slice(0, 300);
      }
      overlay.index = 0;
    }
    this.changed();
  }

  private toggleWorkspaceMode() {
    this.enhanced = !this.enhanced;
    this.detailedStatus = false;
    this.statusScroll = 0;
    if (this.enhanced) this.openWorkspace();
    else this.workspace = undefined;
    this.changed();
  }
  get modelSuggestion() {
    return !this.question && this.cursor === this.draft.length
      ? modelCompletion(this.draft, this.modelIds)
      : undefined;
  }
  scroll = 0;
  maxScroll = 0;
  scrollTranscript(rows: number) {
    if (this.workspace?.view === 'transcript' && !this.question) {
      const max = Math.max(0, this.transcriptViewLines().length - this.transcriptViewRows);
      this.workspace.index = Math.max(0, Math.min(max, this.workspace.index + rows));
      this.changed();
      return;
    }
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
  private promptHistory: string[];

  constructor(private readonly savedHistory?: PromptHistory) {
    super();
    this.promptHistory = savedHistory?.load().map(clean).filter(prompt => prompt.trim() && !prompt.trimStart().startsWith('/')) ?? [];
  }
  private historyIndex?: number;
  private preferredColumn?: number;

  private resetNavigation() {
    this.historyIndex = undefined;
    this.preferredColumn = undefined;
  }

  private moveVertical(direction: -1 | 1) {
    const rows = layoutDraft(this.draft, this.draftWidth);
    const index = rows.findLastIndex(row => row.positions[0].offset <= this.cursor);
    const target = rows[index + direction];
    if (target) {
      const current = rows[index].positions.findLast(position => position.offset <= this.cursor);
      this.preferredColumn ??= current?.column ?? 0;
      const column = this.preferredColumn;
      this.cursor = (target.positions.findLast(position => position.column <= column) ?? target.positions[0]).offset;
      this.changed();
      return;
    }

    if (this.historyIndex === undefined && (direction === 1 || this.draft !== '')) return;
    const next = (this.historyIndex ?? this.promptHistory.length) + direction;
    if (next < 0 || next > this.promptHistory.length) return;
    this.historyIndex = next === this.promptHistory.length ? undefined : next;
    this.draft = this.promptHistory[next] ?? '';
    this.cursor = this.draft.length;
    this.preferredColumn = undefined;
    this.changed();
  }

  private waiter?: (value: string | null) => void;
  private questions: Question[] = [];
  get question() { return this.questions[0]; }
  changed() { this.emit('change'); }
  write = (text: string) => { this.transcript = (this.transcript + clean(text)).slice(-200_000); this.changed(); };
  insert(text: string, pasted = false) {
    if (this.workspace && !this.question) {
      if (this.workspace.view === 'history' || this.workspace.view === 'models') {
        this.workspace.query = (this.workspace.query + clean(text).replace(/\n/g, '')).slice(0, 300);
        this.workspace.index = 0;
        this.changed();
      }
      return;
    }
    // Pasted text must never answer an approval question.
    if (pasted && this.question) return;
    const value = clean(text);
    if (this.question) this.question.draft += value.replace(/\n/g, '');
    else if (value) {
      this.resetNavigation();
      this.draft = this.draft.slice(0, this.cursor) + value + this.draft.slice(this.cursor);
      this.cursor += value.length;
    }
    this.changed();
  }
  submit(interrupt = false) {
    if (this.closed) return;
    if (this.question) { const q = this.questions.shift()!; q.cleanup(); q.resolve(q.draft); this.changed(); return; }
    const value = this.draft;
    this.cancelDraft(false, false);
    if (!value.trim()) { this.changed(); return; }
    if (value.trim().toLowerCase() === '/ui') { this.toggleWorkspaceMode(); return; }
    if (this.enhanced && value.trim().toLowerCase() === '/model') { this.openWorkspace('models'); return; }
    if (value.trim() === '/status') { this.panelVisible = !this.panelVisible; this.changed(); return; }
    if (!value.trimStart().startsWith('/')) {
      if (this.promptHistory.at(-1) !== value) {
        this.promptHistory.push(value);
        if (this.promptHistory.length > PROMPT_HISTORY_LIMIT) this.promptHistory.shift();
      }
      this.savedHistory?.append(value);
    }
    this.dispatch(value, interrupt);
  }

  private dispatch(value: string, interrupt: boolean) {
    this.write(`\n> ${value}\n`);
    if (interrupt) this.onInterruptPrompt();
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(value);
    } else {
      if (interrupt) this.queue.unshift(value);
      else this.queue.push(value);
      this.queueRevision++;
      this.write(`(${interrupt ? '현재 작업 중단 요청 · 우선 실행' : '전송 대기'} ${this.queue.length}개 — 현재 작업이 끝나면 실행해요)\n`);
    }
    this.changed();
  }

  readLine(prompt: string, signal?: AbortSignal): Promise<string | null> {
    this.prompt = clean(prompt); this.changed();
    if (signal) return this.ask(prompt, signal);
    if (this.closed) return Promise.resolve(null);
    if (this.queue.length) { const value = this.queue.shift()!; this.queueRevision++; this.changed(); return Promise.resolve(value); }
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
    // A held menu-selection key must not submit the recalled draft.
    if (this.enhanced && key.eventType === 'repeat' && key.return && !this.question) return;
    if (key.ctrl && input === 'c') { this.onInterrupt(); return; }
    if (key.ctrl && input === 'd') { this.onInterruptPrompt(); this.close(); return; }
    if (this.enhanced && !this.question) {
      if (key.ctrl && !key.meta && !key.shift && !key.super && !key.hyper && input === 'r') {
        this.openWorkspace('history');
        return;
      }
      if (key.meta && !key.ctrl && !key.shift && (input === 'm' || input === 'p')) {
        this.openWorkspace(input === 'p' ? 'models' : 'menu');
        return;
      }
      if (this.workspace) {
        this.handleWorkspaceKey(input, key);
        return;
      }
    }
    if (key.tab && key.shift && !this.question) { this.onCycle(); return; }
    if (key.tab && !this.question && this.modelSuggestion) {
      this.resetNavigation();
      this.draft = this.modelSuggestion;
      this.cursor = this.draft.length;
      this.changed();
      return;
    }
    if (key.tab && !this.question) { this.statusFocused = !this.statusFocused; this.changed(); return; }
    if (key.pageUp || key.pageDown) { if (this.statusFocused) this.statusScroll = Math.max(0, Math.min(this.displayStatus().length - 1, this.statusScroll + (key.pageUp ? -5 : 5))); else { this.scrollTranscript(key.pageUp ? 10 : -10); return; } this.changed(); return; }
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
    if (key.upArrow || key.downArrow) {
      if (!this.question) this.moveVertical(key.upArrow ? -1 : 1);
      return;
    }
    if (key.backspace || key.delete) {
      if (!this.question) this.resetNavigation();
      if (this.question) this.question.draft = this.question.draft.slice(0, -1);
      else if (key.delete) this.draft = this.draft.slice(0, this.cursor) + this.draft.slice(this.cursor + ([...this.draft.slice(this.cursor)][0]?.length ?? 0));
      else if (this.cursor > 0) { const previous = [...this.draft.slice(0, this.cursor)].at(-1)!; this.draft = this.draft.slice(0, this.cursor - previous.length) + this.draft.slice(this.cursor); this.cursor -= previous.length; }
      this.changed(); return;
    }
    if (!this.question && (key.leftArrow || key.rightArrow || key.home || key.end)) {
      this.preferredColumn = undefined;
      if (key.home) this.cursor = 0; else if (key.end) this.cursor = this.draft.length;
      else if (key.leftArrow) this.cursor -= [...this.draft.slice(0, this.cursor)].at(-1)?.length ?? 0;
      else this.cursor += [...this.draft.slice(this.cursor)][0]?.length ?? 0;
      this.changed(); return;
    }
    if (!key.ctrl && !key.meta && !key.escape && !key.tab) this.insert(input);
  }
  close() {
    if (this.closed) return;
    this.workspace = undefined;
    this.closed = true; this.queue = []; this.waiter?.(null); this.waiter = undefined;
    for (const q of this.questions.splice(0)) { q.cleanup(); q.resolve(null); }
    this.changed();
  }
  cancelDraft(notify = true, recover = true) {
    if (recover && this.enhanced) this.stashDraft();
    this.draft = '';
    this.cursor = 0;
    this.resetNavigation();
    if (notify) this.changed();
  }
}

function WorkspaceOverlayView({ input, maxRows }: { input: InteractiveInput; maxRows: number }) {
  const overlay = input.workspace!;
  const entries = input.workspaceEntries();
  const start = Math.max(0, overlay.index - maxRows + 1);
  const title = { menu: '작업 모드', queue: '대기 요청', history: '기록 검색', models: '모델 선택', transcript: '대화 기록' }[overlay.view];
  if (overlay.view === 'transcript') {
    const lines = input.transcriptViewLines();
    const end = Math.max(Math.min(lines.length, input.transcriptViewRows), lines.length - overlay.index);
    return <Box flexGrow={1} flexDirection="column" paddingX={1} overflow="hidden" borderStyle="round">
      <Text bold color="cyan" wrap="truncate-end">{title} · ↑/↓/PgUp/PgDn/휠 이동 · Esc 뒤로</Text>
      <Text>{lines.slice(Math.max(0, end - input.transcriptViewRows), end).join('\n')}</Text>
    </Box>;
  }
  const searchable = overlay.view === 'history' || overlay.view === 'models';
  return <Box flexGrow={1} flexDirection="column" paddingX={1} overflow="hidden" borderStyle="round">
    <Text bold color="cyan">{title} · ↑/↓ 이동 · Esc 뒤로</Text>
    {searchable && <Text wrap="truncate-end">검색: {overlay.query}▌</Text>}
    {overlay.view === 'queue' && <Text wrap="truncate-end">Enter 회수 후 편집 · Delete 제거</Text>}
    {overlay.view === 'models' && <Text wrap="truncate-end">Enter 선택 · 변경할 모델만 실제 API로 확인 (소량 과금)</Text>}
    {overlay.loading && <Text dimColor>모델 목록 조회 중…</Text>}
    {overlay.notice && <Text color="yellow" wrap="truncate-end">{overlay.notice}</Text>}
    {entries.length === 0 && <Text dimColor>표시할 항목이 없어요.</Text>}
    {entries.slice(start, start + maxRows).map((entry, i) =>
      <Text key={start + i} color={start + i === overlay.index ? 'cyan' : undefined} wrap="truncate-end">
        {start + i === overlay.index ? '› ' : '  '}{overlay.view === 'models' && entry === input.currentModel() ? '✓ ' : ''}{clean(entry).replaceAll('\n', ' ↵ ')}
      </Text>,
    )}
    {overlay.view === 'queue' && entries[overlay.index] !== undefined && <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Text dimColor>선택한 요청 미리 보기</Text>
      <Text>{clean(entries[overlay.index])}</Text>
    </Box>}
  </Box>;
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
  input.transcriptViewWidth = Math.max(1, width - 4);
  input.transcriptViewRows = Math.max(1, height - 6);
  const panelWidth = input.enhanced && !input.detailedStatus ? 27 : 42;
  const side = input.panelVisible && width >= 90;
  const paneWidth = side ? width - panelWidth : width;
  const panelRows = side ? undefined : 5;
  // Reserve a cell for the cursor so drawing it cannot rewrap the draft.
  input.draftWidth = Math.max(1, paneWidth - 3);
  const rows = useMemo(() => layoutDraft(input.draft, input.draftWidth), [input.draft, input.draftWidth]);
  const questionRows = input.question ? wrapAnsi(input.question.prompt, Math.max(1, paneWidth - 2), { hard: true }).split('\n').length : 1;
  const inputLines = input.question ? Math.min(10, questionRows + 1) : Math.min(7, Math.max(2, rows.length + 1));
  const transcriptRows = Math.max(3, height - inputLines - (side || !input.panelVisible ? 6 : 11));
  const history = useMemo(() => wrapAnsi(input.transcript, Math.max(1, paneWidth), { hard: true }).split('\n'), [input.transcript, paneWidth]);
  input.maxScroll = Math.max(0, history.length - transcriptRows);
  const end = history.length - Math.min(input.scroll, input.maxScroll);
  const visible = history.slice(Math.max(0, end - transcriptRows), end).join('\n');
  const cursorLine = rows.findLastIndex(row => row.positions[0].offset <= input.cursor);
  const draftStart = Math.max(0, cursorLine - 3);
  const visibleDraft = input.question
    ? wrapAnsi(input.question.draft, Math.max(1, paneWidth - 2), { hard: true }).split('\n').slice(0, 6).join('\n')
    : rows.slice(draftStart, draftStart + 6).map((row, index) => {
    if (draftStart + index !== cursorLine) return row.text;
    const column = row.positions.findLastIndex(position => position.offset <= input.cursor);
    // Match the layout's tab expansion when locating the cursor in displayed text.
    const offset = row.positions[column].offset;
    const displayIndex = input.draft.slice(row.positions[0].offset, offset).replaceAll('\t', ' '.repeat(Math.min(4, input.draftWidth))).length;
    return row.text.slice(0, displayIndex) + '▌' + row.text.slice(displayIndex);
  }).join('\n');
  if (!ready) return <Text>CVP UI 준비 중…</Text>;
  return <Box flexDirection="column" width={width} height={height - 1} overflow="hidden">
    <Text bold color="cyan" wrap="truncate-end">CVP CLI{input.enhanced ? ' · 작업 모드' : ''} · {input.busy() ? '작업 중' : '입력 가능'} · 전송 대기 {input.queue.length}개</Text>
    {input.workspace && !input.question
      ? <WorkspaceOverlayView input={input} maxRows={Math.max(2, Math.min(8, height - 8))}/>
      : <Box flexGrow={1} flexDirection={side ? 'row' : 'column'}>
      <Box flexDirection="column" flexGrow={1} flexShrink={0} width={paneWidth} height={side || !input.panelVisible ? height - 3 : height - 8}>
        <Box flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden"><Text wrap="wrap">{visible}</Text></Box>
        <Box borderStyle="round" borderColor={input.question ? 'yellow' : 'green'} flexDirection="column" flexShrink={0} height={inputLines + 2} overflow="hidden">
          <Text color={input.question ? 'yellow' : 'green'}>{input.question ? wrapAnsi(input.question.prompt, Math.max(1, paneWidth - 2), { hard: true }).split('\n').slice(-(inputLines - 1)).join('\n') : input.prompt}</Text>
          <Text>{visibleDraft}</Text>
        </Box>
      </Box>
      {input.panelVisible && <Box width={side ? panelWidth : width} height={panelRows} borderStyle="round" borderColor={input.statusFocused ? "cyan" : "gray"} flexDirection="column" flexShrink={0} overflow="hidden"><Text bold>상태 · Tab/PgUp/PgDn 이동</Text><Text wrap="wrap">{wrapAnsi(input.displayStatus().map(clean).join('\n'), side ? panelWidth - 2 : Math.max(1, width - 2), { hard: true }).split('\n').slice(input.statusScroll).join('\n')}</Text></Box>}
    </Box>}
    <Text dimColor wrap="truncate-end">{input.modelSuggestion ? `Tab 자동완성 · ${input.modelSuggestion}` : <>{input.enhanced ? 'Alt+M 작업 메뉴 · Alt+P 모델 · Ctrl+R 기록 · ' : '/ui 작업 모드 · '}Enter {input.enterAction} · Ctrl+Enter {input.ctrlEnterAction} · Shift+Enter {input.shiftEnterAction}{input.interruptKey ? ` · ${input.interruptKey} interrupt` : ''} · 휠/PgUp/PgDn 기록 · Shift+드래그 선택</>}</Text>
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
