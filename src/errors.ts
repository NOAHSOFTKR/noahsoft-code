import Anthropic from '@anthropic-ai/sdk';

export type ErrorCategory =
  | 'auth'
  | 'permission'
  | 'model_not_found'
  | 'rate_limit'
  | 'credit'
  | 'overloaded'
  | 'invalid_request'
  | 'server'
  | 'network'
  | 'refusal'
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  status?: number;
  message: string;
  hint: string;
  retryable: boolean;
}

const HINTS: Record<ErrorCategory, string> = {
  auth: 'API 키가 유효하지 않거나 폐기되었습니다. Console에서 키를 확인하세요.',
  permission: '이 API 키의 조직/워크스페이스에 해당 모델 권한이 없습니다. CVP 승인이 모든 모델 접근을 보장하지 않습니다.',
  model_not_found: '모델 ID가 없거나 이 조직에 공개되지 않았습니다. `cvp models`로 조회 가능한 목록을 확인하세요.',
  rate_limit: 'Rate Limit에 도달했습니다. 잠시 후 다시 시도하세요(Console의 Limits 페이지 참고).',
  credit: 'API 크레딧/잔액이 부족하거나 결제 설정 문제입니다. Console의 Billing에서 조직 크레딧을 확인하세요.',
  overloaded: 'API가 일시적으로 과부하 상태입니다. 잠시 후 다시 시도하세요.',
  invalid_request: '요청이 거부되었습니다. 메시지를 확인하세요.',
  server: 'Anthropic API 서버 오류입니다. 잠시 후 다시 시도하세요.',
  network: '네트워크 연결 오류입니다. 프록시/방화벽 설정을 확인하세요.',
  refusal: '모델이 요청을 거절했습니다(stop_reason: refusal).',
  unknown: '알 수 없는 오류입니다.',
};

function isCreditMessage(msg: string): boolean {
  return /credit balance|insufficient.*credit|billing|purchase credits|out of credits|spend limit/i.test(msg);
}

function make(category: ErrorCategory, message: string, status?: number): ClassifiedError {
  const retryable = ['rate_limit', 'overloaded', 'server', 'network'].includes(category);
  return { category, status, message, hint: HINTS[category], retryable };
}

/** @anthropic-ai/sdk 의 타입별 예외를 분류한다(구체 클래스부터). */
export function classifyApiError(err: unknown): ClassifiedError {
  if (err instanceof Anthropic.AuthenticationError) return make('auth', err.message, err.status);
  if (err instanceof Anthropic.PermissionDeniedError) {
    return make(isCreditMessage(err.message) ? 'credit' : 'permission', err.message, err.status);
  }
  if (err instanceof Anthropic.NotFoundError) return make('model_not_found', err.message, err.status);
  if (err instanceof Anthropic.RateLimitError) return make('rate_limit', err.message, err.status);
  if (err instanceof Anthropic.BadRequestError) {
    return make(isCreditMessage(err.message) ? 'credit' : 'invalid_request', err.message, err.status);
  }
  if (err instanceof Anthropic.APIConnectionError) return make('network', err.message);
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    if (status === 402) return make('credit', err.message, status);
    if (status === 529) return make('overloaded', err.message, status);
    if (status && status >= 500) return make('server', err.message, status);
    return make('unknown', err.message, status);
  }
  return make('unknown', err instanceof Error ? err.message : String(err));
}

/** Agent SDK 의 SDKAssistantMessageError 문자열을 분류한다. */
export function classifyAgentError(code: string | undefined, text?: string, status?: number | null): ClassifiedError {
  const msg = text || code || 'unknown';
  switch (code) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return make('auth', msg, status ?? undefined);
    case 'billing_error':
    case 'account_on_hold':
      return make('credit', msg, status ?? undefined);
    case 'rate_limit':
      return make('rate_limit', msg, status ?? undefined);
    case 'overloaded':
      return make('overloaded', msg, status ?? undefined);
    case 'model_not_found':
      return make('model_not_found', msg, status ?? undefined);
    case 'invalid_request':
      return make(isCreditMessage(msg) ? 'credit' : 'invalid_request', msg, status ?? undefined);
    case 'server_error':
      return make('server', msg, status ?? undefined);
  }
  if (status === 401) return make('auth', msg, 401);
  if (status === 403) return make(isCreditMessage(msg) ? 'credit' : 'permission', msg, 403);
  if (status === 404) return make('model_not_found', msg, 404);
  if (status === 429) return make('rate_limit', msg, 429);
  if (isCreditMessage(msg)) return make('credit', msg, status ?? undefined);
  return make('unknown', msg, status ?? undefined);
}
