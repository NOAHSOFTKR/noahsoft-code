import fs from 'node:fs';
import path from 'node:path';
import { cvpHome, type FileConfig } from './config.js';

/** API 요청 1건의 토큰 사용량 (스트림 이벤트에서 수집) */
export interface RequestUsage {
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  at: string;
}

export interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costBasis?: string;
}

export interface SessionLedger {
  sessionId: string;
  costUsd: number;
  turns: number;
  byModel: Record<string, ModelTotals>;
  requests: RequestUsage[];
  updatedAt: string;
}

/** SDK 결과 메시지의 modelUsage 와 같은 모양(필요 필드만) */
export interface SdkModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  costBasis?: string;
}

const MAX_REQUESTS_KEPT = 200;

function ledgerDir(): string {
  return path.join(cvpHome(), 'usage');
}

function ledgerFile(sessionId: string): string {
  // 세션 ID는 UUID 이지만 경로 조작 방지를 위해 정규화
  return path.join(ledgerDir(), `${sessionId.replace(/[^a-zA-Z0-9-]/g, '_')}.json`);
}

export function loadLedger(sessionId: string): SessionLedger | undefined {
  try {
    return JSON.parse(fs.readFileSync(ledgerFile(sessionId), 'utf8')) as SessionLedger;
  } catch {
    return undefined;
  }
}

function saveLedger(l: SessionLedger): void {
  fs.mkdirSync(ledgerDir(), { recursive: true });
  fs.writeFileSync(ledgerFile(l.sessionId), JSON.stringify(l, null, 2), 'utf8');
}

/**
 * SDK 가격표가 없는 모델(costBasis 'unknown')에 대해 사용자가 config 에 넣은 단가로 추정.
 * 단가가 없으면 undefined — 임의로 계산하지 않는다.
 */
export function estimateFromPricing(
  model: string,
  u: SdkModelUsage,
  pricing: FileConfig['pricing'],
): number | undefined {
  const p = pricing?.[model];
  if (!p) return undefined;
  const per = 1_000_000;
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadInputTokens * (p.cacheRead ?? p.input * 0.1) +
      u.cacheCreationInputTokens * (p.cacheWrite ?? p.input * 1.25)) /
    per
  );
}

export class BudgetExceededError extends Error {
  constructor(public spent: number, public limit: number) {
    super(`세션 예상 비용 $${spent.toFixed(4)} 가 한도 $${limit.toFixed(2)} 에 도달하여 추가 요청을 차단합니다.`);
  }
}

/**
 * 세션 비용/토큰 추적기.
 * Agent SDK 의 result.total_cost_usd 는 query() 단위로 누적되며, 재개(resume)한 세션은
 * 트랜스크립트에 저장된 합계부터 이어진다(SDK 문서). 이 값이 '추정치'이며 청구서가 아님에 유의.
 */
export class CostTracker {
  ledger: SessionLedger;
  /** 현재 query() 프로세스에서 마지막으로 본 누적 비용 */
  private lastProcessTotal: number | undefined;
  /** 재개 시 SDK 누적값이 이전 합계를 포함하지 않는 경우 더할 오프셋 */
  private offset = 0;
  /** 이번 query() 시작 시점의 세션 비용(maxBudgetUsd 계산용) */
  readonly costAtQueryStart: number;
  lastTurnCost = 0;
  private pendingRequests = new Map<string, RequestUsage>();
  /** 재개 시점의 모델별 기준값 */
  private baseByModel: Record<string, ModelTotals>;

  constructor(
    sessionId: string | undefined,
    public limitUsd: number,
    private pricing: FileConfig['pricing'] = undefined,
  ) {
    const prior = sessionId ? loadLedger(sessionId) : undefined;
    this.ledger = prior ?? {
      sessionId: sessionId ?? '',
      costUsd: 0,
      turns: 0,
      byModel: {},
      requests: [],
      updatedAt: new Date().toISOString(),
    };
    this.costAtQueryStart = this.ledger.costUsd;
    this.baseByModel = structuredClone(this.ledger.byModel);
  }

  get sessionCost(): number {
    return this.ledger.costUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.ledger.costUsd);
  }

  /** 다음 요청을 보내기 전에 호출: 한도 초과 시 예외 */
  assertWithinBudget(): void {
    if (this.ledger.costUsd >= this.limitUsd) throw new BudgetExceededError(this.ledger.costUsd, this.limitUsd);
  }

  bindSession(sessionId: string): void {
    if (this.ledger.sessionId === sessionId) return;
    this.ledger.sessionId = sessionId;
  }

  // ---- 요청별 토큰(스트림 이벤트) ----
  onMessageStart(messageId: string, model: string, usage: Record<string, unknown> | undefined): void {
    this.pendingRequests.set(messageId, {
      messageId,
      model,
      inputTokens: Number(usage?.input_tokens ?? 0),
      outputTokens: Number(usage?.output_tokens ?? 0),
      cacheReadTokens: Number(usage?.cache_read_input_tokens ?? 0),
      cacheWriteTokens: Number(usage?.cache_creation_input_tokens ?? 0),
      at: new Date().toISOString(),
    });
  }

  onMessageDelta(messageId: string, usage: Record<string, unknown> | undefined): void {
    const r = this.pendingRequests.get(messageId);
    if (!r || !usage) return;
    // message_delta 의 usage 는 누적값
    if (usage.output_tokens != null) r.outputTokens = Number(usage.output_tokens);
    if (usage.input_tokens != null) r.inputTokens = Number(usage.input_tokens);
    if (usage.cache_read_input_tokens != null) r.cacheReadTokens = Number(usage.cache_read_input_tokens);
    if (usage.cache_creation_input_tokens != null) r.cacheWriteTokens = Number(usage.cache_creation_input_tokens);
  }

  onMessageStop(messageId: string): RequestUsage | undefined {
    const r = this.pendingRequests.get(messageId);
    if (!r) return undefined;
    this.pendingRequests.delete(messageId);
    this.ledger.requests.push(r);
    if (this.ledger.requests.length > MAX_REQUESTS_KEPT) {
      this.ledger.requests.splice(0, this.ledger.requests.length - MAX_REQUESTS_KEPT);
    }
    return r;
  }

  /** 턴 결과(result 메시지)를 반영. 반환값은 이번 턴의 비용 증분 */
  onResult(sessionId: string, totalCostUsd: number, modelUsage: Record<string, SdkModelUsage>): number {
    this.bindSession(sessionId);
    const prior = this.ledger.costUsd;
    if (this.lastProcessTotal === undefined) {
      // 이 프로세스의 첫 결과. SDK가 이전 합계를 이어받았는지 판단한다:
      // 이어받았다면 누적 비용과 모델별 입력 토큰이 원장 값 이상이어야 한다.
      const restored =
        totalCostUsd + 1e-9 >= prior &&
        Object.entries(this.baseByModel).every(([m, b]) => (modelUsage[m]?.inputTokens ?? 0) >= b.inputTokens);
      this.offset = restored ? 0 : prior;
    }
    this.lastProcessTotal = totalCostUsd;

    // 모델별 합계 (SDK 가격표에 없는 모델은 사용자 단가로 보정)
    let extra = 0;
    const byModel: Record<string, ModelTotals> = {};
    for (const [model, u] of Object.entries(modelUsage)) {
      let cost = u.costUSD;
      if (u.costBasis === 'unknown' || (!cost && (u.inputTokens || u.outputTokens))) {
        const est = estimateFromPricing(model, u, this.pricing);
        if (est !== undefined) {
          extra += est - cost;
          cost = est;
        }
      }
      byModel[model] = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadInputTokens,
        cacheWriteTokens: u.cacheCreationInputTokens,
        costUsd: cost,
        costBasis: u.costBasis,
      };
    }
    const newTotal = this.offset + totalCostUsd + extra;
    this.ledger.costUsd = Math.max(prior, newTotal);
    this.mergeByModel(byModel);
    this.ledger.turns += 1;
    this.ledger.updatedAt = new Date().toISOString();
    this.lastTurnCost = this.ledger.costUsd - prior;
    if (this.ledger.sessionId) saveLedger(this.ledger);
    return this.lastTurnCost;
  }

  private mergeByModel(current: Record<string, ModelTotals>): void {
    if (this.offset > 0) {
      // SDK 누적값이 이번 프로세스분만 담는 경우: 이전 값과 합산
      for (const [m, t] of Object.entries(current)) {
        const base = this.baseByModel[m];
        this.ledger.byModel[m] = base
          ? {
              inputTokens: base.inputTokens + t.inputTokens,
              outputTokens: base.outputTokens + t.outputTokens,
              cacheReadTokens: base.cacheReadTokens + t.cacheReadTokens,
              cacheWriteTokens: base.cacheWriteTokens + t.cacheWriteTokens,
              costUsd: base.costUsd + t.costUsd,
              costBasis: t.costBasis,
            }
          : t;
      }
    } else {
      for (const [m, t] of Object.entries(current)) this.ledger.byModel[m] = t;
    }
  }

  totals(): { input: number; output: number; cacheRead: number; cacheWrite: number } {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const m of Object.values(this.ledger.byModel)) {
      t.input += m.inputTokens;
      t.output += m.outputTokens;
      t.cacheRead += m.cacheReadTokens;
      t.cacheWrite += m.cacheWriteTokens;
    }
    return t;
  }
}
