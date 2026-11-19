import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';

const nonnegative = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Observed main-session events plus explicitly labelled estimates; no extra model calls. */
export class RuntimeStatus {
  private context?: { used_tokens: number; window_tokens: number; threshold_tokens: number | null; remaining_tokens: number | null; enabled: boolean | null; observed_at: string };
  private cache?: { read_tokens: number; write_tokens: number; uncached_tokens: number; ttl_ms: number; ttl_assumed: boolean; started_at: number };
  private cacheInvalidated = false;
  private compacting = false;
  private compactCount = 0;
  private lastCompact?: { trigger: 'auto' | 'manual'; before_tokens: number | null; after_tokens: number | null; at: string };
  private compactError?: string;

  observeContext(data: SDKControlGetContextUsageResponse): void {
    const used = nonnegative(data.totalTokens), window = nonnegative(data.rawMaxTokens ?? data.maxTokens);
    if (used === undefined || window === undefined || window <= 0) { this.context = undefined; return; }
    const threshold = nonnegative(data.autoCompactThreshold);
    const validThreshold = threshold !== undefined && threshold <= window ? threshold : undefined;
    this.context = { used_tokens: used, window_tokens: window, threshold_tokens: validThreshold ?? null,
      remaining_tokens: validThreshold === undefined || data.isAutoCompactEnabled === false ? null : Math.max(0, validThreshold - used),
      enabled: typeof data.isAutoCompactEnabled === 'boolean' ? data.isAutoCompactEnabled : null, observed_at: new Date().toISOString() };
  }
  clearContext(): void { this.context = undefined; }
  observeCache(usage: Record<string, unknown> | undefined, startedAt: number): void {
    const read = nonnegative(usage?.cache_read_input_tokens), write = nonnegative(usage?.cache_creation_input_tokens);
    if (read === undefined && write === undefined) { this.cache = undefined; return; }
    const creation = usage?.cache_creation as Record<string, unknown> | undefined;
    const short = nonnegative(creation?.ephemeral_5m_input_tokens) ?? 0;
    const long = nonnegative(creation?.ephemeral_1h_input_tokens) ?? 0;
    const knownLong = long > 0 && short === 0 && long === write && (read ?? 0) === 0;
    this.cache = { read_tokens: read ?? 0, write_tokens: write ?? 0, uncached_tokens: nonnegative(usage?.input_tokens) ?? 0,
      ttl_ms: knownLong ? 3600000 : 300000, ttl_assumed: !knownLong && !(short > 0), started_at: startedAt };
    this.cacheInvalidated = false;
  }
  observeSystem(msg: Record<string, any>): void {
    if (msg.subtype === 'status') {
      if (msg.status === 'compacting') { this.compacting = true; this.compactError = undefined; }
      else if (msg.status === null || msg.compact_result) this.compacting = false;
      if (msg.compact_result === 'failed') this.compactError = String(msg.compact_error ?? '압축 실패');
    }
    if (msg.subtype === 'compact_boundary') {
      const meta = msg.compact_metadata ?? {};
      if (!['auto', 'manual'].includes(meta.trigger)) return;
      this.compacting = false; this.compactCount++; this.compactError = undefined;
      this.lastCompact = { trigger: meta.trigger, before_tokens: nonnegative(meta.pre_tokens) ?? null,
        after_tokens: nonnegative(meta.post_tokens) ?? null, at: new Date().toISOString() };
      this.invalidate();
    }
  }
  invalidate(): void { this.cacheInvalidated = true; this.context = undefined; }
  snapshot(now = Date.now()) {
    const c = this.cache;
    const active = c && !this.cacheInvalidated && c.read_tokens + c.write_tokens > 0;
    const remaining = active ? Math.max(0, c.ttl_ms - Math.max(0, now - c.started_at)) : null;
    const total = c ? c.read_tokens + c.write_tokens + c.uncached_tokens : 0;
    return {
      scope: 'main_session',
      autocompact: { enabled: this.context?.enabled ?? null, state: this.compacting ? 'compacting' : this.compactError ? 'failed' : this.lastCompact ? 'completed' : 'not_observed',
        count: this.compactCount, last: this.lastCompact ?? null, error: this.compactError ?? null },
      context: this.context ? { ...this.context, estimated: true } : null,
      cache: { read_tokens: c?.read_tokens ?? null, write_tokens: c?.write_tokens ?? null,
        observed_read_ratio: total > 0 && c ? c.read_tokens / total : null,
        reuse_estimate: !c || this.cacheInvalidated ? 'unknown' : !active ? 'not_observed' : remaining === 0 ? 'possibly_expired' : 'likely_warm',
        ttl_seconds_assumed: active && c?.ttl_assumed ? c.ttl_ms / 1000 : null,
        estimated_ttl_remaining_seconds: remaining === null ? null : Math.floor(remaining / 1000), estimated: true },
    };
  }
  lines(): string[] {
    const s = this.snapshot();
    const state = { compacting: '압축 중', completed: '최근 압축 완료', failed: '압축 실패', not_observed: '아직 압축 이벤트 없음' }[s.autocompact.state];
    const enabled = s.autocompact.enabled === null ? '설정 미확인' : s.autocompact.enabled ? '켜짐' : '꺼짐';
    const context = s.context ? `${s.context.used_tokens.toLocaleString()} / ${s.context.window_tokens.toLocaleString()} 토큰 (${(s.context.used_tokens/s.context.window_tokens*100).toFixed(1)}%, 추정) · 압축 임계까지 예상 여유 ${s.context.remaining_tokens?.toLocaleString() ?? '미확인'}` : '예상 여유 미확인';
    const cache = { unknown: '재사용 미확인', not_observed: '캐시 사용 미관측', possibly_expired: '만료 가능', likely_warm: '재사용 가능성 있음' }[s.cache.reuse_estimate];
    return [`AutoCompact: ${enabled} · ${state} · ${context}`, `Cache: 읽기 ${s.cache.read_tokens ?? '미확인'} / 쓰기 ${s.cache.write_tokens ?? '미확인'} 토큰(실측)${s.cache.observed_read_ratio===null?'':` · 읽기 비율 ${(s.cache.observed_read_ratio*100).toFixed(1)}%`} · ${cache}(추정)${s.cache.estimated_ttl_remaining_seconds === null ? '' : ` · TTL 예상 ${s.cache.estimated_ttl_remaining_seconds}s${s.cache.ttl_seconds_assumed ? ' (기본 5분 가정)' : ''}`}`];
  }
}
