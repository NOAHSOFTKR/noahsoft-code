import Anthropic from '@anthropic-ai/sdk';
import { classifyApiError, type ClassifiedError } from './errors.js';

export function apiClient(apiKey: string): Anthropic {
  // 인증 수단을 API 키로 고정(authToken 은 명시적으로 비움)
  return new Anthropic({ apiKey, authToken: null, maxRetries: 1, timeout: 60_000 });
}

export interface ListedModel {
  id: string;
  displayName: string;
  createdAt: string;
  maxInputTokens?: number;
  maxTokens?: number;
}

/** GET /v1/models — 이 키로 "조회 가능한" 모델 목록. 실제 호출 권한과는 다를 수 있다. */
export async function listModels(client: Anthropic): Promise<ListedModel[]> {
  const out: ListedModel[] = [];
  for await (const m of client.models.list({ limit: 100 })) {
    const extra = m as unknown as { max_input_tokens?: number; max_tokens?: number };
    out.push({
      id: m.id,
      displayName: m.display_name,
      createdAt: String(m.created_at),
      maxInputTokens: extra.max_input_tokens,
      maxTokens: extra.max_tokens,
    });
  }
  return out;
}

/** GET /v1/models/{id} — 목록에서 보이는지(존재/공개 여부)만 확인. 과금 없음. */
export async function retrieveModel(
  client: Anthropic,
  id: string,
): Promise<{ ok: true; model: ListedModel } | { ok: false; error: ClassifiedError }> {
  try {
    const m = await client.models.retrieve(id);
    return { ok: true, model: { id: m.id, displayName: m.display_name, createdAt: String(m.created_at) } };
  } catch (err) {
    return { ok: false, error: classifyApiError(err) };
  }
}

export interface ProbeResult {
  model: string;
  ok: boolean;
  /** 응답 헤더의 조직 ID (있을 경우) */
  organizationId?: string;
  requestId?: string;
  stopReason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  error?: ClassifiedError;
}

/**
 * 실제 Messages API 호출로 모델 사용 권한을 검증한다(소량 과금 발생).
 * 200 응답이면 이 키의 조직이 해당 모델을 호출할 수 있다는 뜻이다.
 */
export async function probeModel(client: Anthropic, model: string): Promise<ProbeResult> {
  try {
    const { data, response } = await client.messages
      .create({
        model,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      })
      .withResponse();
    return {
      model,
      ok: true,
      organizationId: response.headers.get('anthropic-organization-id') ?? undefined,
      requestId: response.headers.get('request-id') ?? undefined,
      stopReason: data.stop_reason,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    };
  } catch (err) {
    const e = classifyApiError(err);
    const headers = (err as { headers?: Headers }).headers;
    return {
      model,
      ok: false,
      error: e,
      organizationId: headers?.get?.('anthropic-organization-id') ?? undefined,
      requestId: headers?.get?.('request-id') ?? undefined,
    };
  }
}

/** 과금 없는 호출(GET /v1/models)로 키 유효성과 조직 ID를 확인한다. */
export async function checkKeyOnline(
  client: Anthropic,
): Promise<{ ok: true; organizationId?: string; modelCount: number } | { ok: false; error: ClassifiedError }> {
  try {
    const { data, response } = await client.models.list({ limit: 100 }).withResponse();
    return {
      ok: true,
      organizationId: response.headers.get('anthropic-organization-id') ?? undefined,
      modelCount: data.data.length,
    };
  } catch (err) {
    return { ok: false, error: classifyApiError(err) };
  }
}
