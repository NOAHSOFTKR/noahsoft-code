import { agentConfigDir } from './config.js';

export type KeyKind = 'console-api-key' | 'oauth-token' | 'admin-key' | 'unknown-format' | 'missing';

export interface KeyCheck {
  kind: KeyKind;
  ok: boolean;
  masked?: string;
  message: string;
}

export function maskKey(key: string): string {
  if (key.length <= 16) return '****';
  return `${key.slice(0, 14)}…${key.slice(-4)}`;
}

/**
 * ANTHROPIC_API_KEY 의 형식만 검사한다(네트워크 호출 없음).
 * Console API 키는 `sk-ant-api` 로 시작한다. 구독(claude.ai) OAuth 토큰(`sk-ant-oat`)과
 * Admin 키(`sk-ant-admin`)는 메시지 호출용 키가 아니므로 거부한다.
 */
export function checkApiKey(key: string | undefined): KeyCheck {
  const k = key?.trim();
  if (!k) {
    return {
      kind: 'missing',
      ok: false,
      message: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Console(platform.claude.com)에서 CVP 조직의 API 키를 발급해 설정하세요.',
    };
  }
  const masked = maskKey(k);
  if (k.startsWith('sk-ant-oat')) {
    return {
      kind: 'oauth-token',
      ok: false,
      masked,
      message: 'Claude 구독(claude.ai) OAuth 토큰으로 보입니다. 이 CLI는 Console API 키만 사용합니다(구독 로그인과 혼동 금지).',
    };
  }
  if (k.startsWith('sk-ant-admin')) {
    return {
      kind: 'admin-key',
      ok: false,
      masked,
      message: 'Admin API 키는 모델 호출에 사용할 수 없습니다. 일반 Console API 키를 사용하세요.',
    };
  }
  if (k.startsWith('sk-ant-api')) {
    return { kind: 'console-api-key', ok: true, masked, message: 'Console API 키 형식입니다.' };
  }
  return {
    kind: 'unknown-format',
    ok: true,
    masked,
    message: '알려진 Console API 키 접두사(sk-ant-api)가 아닙니다. 실제 API 호출로 유효성을 확인하세요.',
  };
}

/** Agent SDK 자식 프로세스에 넘길 환경변수 중, 다른 인증 경로로 새어 나갈 수 있는 항목 */
const STRIPPED_ENV = [
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  // 이 CLI가 직접 고르는 값과 충돌하지 않도록 제거
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

/**
 * Agent SDK 에 전달할 환경을 만든다.
 * - ANTHROPIC_API_KEY 만 인증 수단으로 남긴다.
 * - CLAUDE_CONFIG_DIR 를 CLI 전용 디렉터리로 바꿔, 사용자의 Claude 구독 로그인 자격 증명이나
 *   ~/.claude 설정(apiKeyHelper, 권한 규칙, 훅)이 섞이지 않도록 한다.
 */
export function buildAgentEnv(apiKey: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of STRIPPED_ENV) delete env[k];
  env.ANTHROPIC_API_KEY = apiKey;
  env.CLAUDE_CONFIG_DIR = agentConfigDir();
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'cvp-cli/0.1.0';
  // 텔레메트리·자동 업데이트 등 부가 트래픽 차단
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}
