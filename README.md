# CVP CLI (`cvp`)

Anthropic 공식 **Claude Agent SDK**(`@anthropic-ai/claude-agent-sdk`)로 만든 독립형 터미널 에이전트입니다.
Console API 키(`ANTHROPIC_API_KEY`)로만 인증하며, CVP(Cyber Verification Program) 승인 조직에서 허용된 모델을 CLI에서 쓰기 위한 도구입니다.
기존 Claude Code CLI를 실행하는 래퍼가 아니라, SDK의 `query()` API를 직접 사용합니다.

## 설치

```bash
npm install
npm run build
npm link        # 전역 명령 `cvp` 등록 (package.json 의 bin 필드)
cvp
```

요구 사항: Node.js 24 이상. Windows의 `Bash` 도구에는 Git for Windows(Git Bash)가 필요하며, Windows에서는 `PowerShell` 도구도 함께 제공됩니다.

## 환경변수

`.env.example`을 `.env`로 복사하거나(작업 디렉터리의 `.env`를 자동으로 읽음) 셸에서 설정합니다.

| 변수 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | **필수.** Console(platform.claude.com)에서 발급한 CVP 조직의 API 키 (`sk-ant-api…`) |
| `CVP_MODEL` | 사용할 모델 ID. **기본값 없음**(하드코딩 금지) |
| `CVP_MAX_SESSION_COST_USD` | 세션당 예상 비용 한도. 기본 `1.00` |
| `CVP_EXPECTED_ORG_ID` | (선택) CVP 조직 ID. `cvp verify`가 API 응답 헤더의 조직 ID와 대조 |
| `CVP_HOME` | (선택) 설정·세션·사용량 저장 위치. 기본 `~/.cvp` |
| `CVP_PERMISSION_MODE` | (선택) 기본 권한 모드: `default` \| `acceptEdits` \| `plan` \| `bypass` |
| `CVP_DEBUG` | (선택) `1`이면 Agent 런타임 stderr 출력 |

PowerShell:
```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-api03-..."
$env:CVP_MODEL = "<model-id>"
cvp
```
Linux:
```bash
export ANTHROPIC_API_KEY=sk-ant-api03-...
export CVP_MODEL=<model-id>
cvp
```

## 사용법

```bash
cvp                                  # 대화형 모드
cvp -p "현재 디렉터리의 코드를 분석해줘"   # 단일 프롬프트 실행 후 종료 (--json 가능)
cvp --model <model-id>               # 이번 실행의 모델 지정
cvp --resume <session-id>            # 세션 재개   (-c: 가장 최근 세션 이어가기)
cvp models                           # 조회 가능한 모델 목록 (GET /v1/models)
cvp models --verify                  # 각 모델에 실제 호출해 사용 권한 검증 (소량 과금)
cvp verify [model-id]                # API 키·조직·모델 접근 검증
cvp sessions                         # 저장된 세션 목록
cvp config set model <model-id>      # 기본 모델 저장
cvp config set budget 2.5            # 세션 예산 저장
```

우선순위: 명령행 옵션 > 환경변수 > `~/.cvp/config.json`.

### 대화형 내부 명령어

| 명령어 | 기능 |
|---|---|
| `/help` | 명령어 안내 |
| `/model [id]` | 모델 조회 / 변경 (실제 API 호출로 권한 검증 후에만 적용) |
| `/mode [모드]` | 권한 모드 조회 / 변경 (Shift+Tab으로도 순환) |
| `/models` | 조회 가능한 모델 목록 |
| `/status` | 인증·모델·세션 상태 |
| `/usage` | 토큰 사용량 및 예상 비용 |
| `/clear` | 현재 대화 초기화(새 세션) |
| `/sessions` | 저장된 세션 목록 |
| `/resume [번호\|ID]` | 이전 세션 재개 |
| `/exit` | 종료 |

입력 줄 끝에 `\`를 붙이면 여러 줄 입력. 실행 중 **Ctrl+C**는 현재 턴만 중단하고, 대기 중 Ctrl+C 두 번(또는 Ctrl+D)은 종료합니다.

응답은 실시간으로 스트리밍되며, Markdown은 완결된 블록 단위로 렌더링하고 코드 블록은 구문 강조합니다(`--raw`이면 원문 그대로).

## 인증과 CVP 검증

- 인증은 `ANTHROPIC_API_KEY`(Console API 키)만 사용합니다. 키는 코드에 하드코딩하지 않습니다.
- Claude 구독(claude.ai) 로그인과 섞이지 않도록:
  - `sk-ant-oat…`(구독 OAuth 토큰), `sk-ant-admin…`(Admin 키)는 거부합니다.
  - Agent SDK 런타임에 `CLAUDE_CONFIG_DIR=~/.cvp/agent`를 지정해 사용자의 `~/.claude`(구독 자격 증명, 설정, 훅, apiKeyHelper)를 읽지 않습니다. `settingSources: []`도 함께 지정합니다.
  - `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex/Foundry 전환 변수를 SDK 환경에서 제거합니다.
  - 세션 시작 시 SDK가 보고한 `apiKeySource`가 `ANTHROPIC_API_KEY`가 아니면 세션을 중단합니다.
- `cvp verify`가 하는 확인:
  1. 키 형식 확인
  2. `GET /v1/models`(과금 없음)로 키 유효성과 응답 헤더 `anthropic-organization-id` 확인
  3. `CVP_EXPECTED_ORG_ID`를 설정했다면 조직 ID 대조
  4. 대상 모델에 대해 목록 조회와 **실제 Messages API 호출**(최대 64 출력 토큰)
- **한계:** 어떤 키가 CVP 승인 조직의 것인지 직접 알려 주는 공식 API는 없습니다. CLI가 확인할 수 있는 것은 조직 ID 대조와 해당 모델을 실제로 호출할 수 있는지 여부뿐입니다. CVP 승인이 모든 모델 접근을 보장하지 않으므로, 목록에 보이는 모델(`cvp models`)과 실제로 호출 가능한 모델(`--verify`)을 구분해 표시합니다.
- 모델 접근 실패(401/403/404/429, 크레딧 부족)는 이유와 함께 표시하며, 사용자 동의 없이 다른 모델로 자동 전환하지 않습니다(`fallbackModel` 미사용).

## 비용과 크레딧

- 크레딧은 SDK가 고르는 것이 아니라, 해당 API 키가 속한 **Console 조직의 과금 설정**에 따라 적용됩니다. Claude 요금제에서 지급되는 월간 API 크레딧을 쓰려면 그 크레딧이 들어 있는 Console 조직의 키를 사용하세요.
- 요청별 입력·출력·캐시 토큰은 스트림 이벤트(`message_start` / `message_delta`)로 집계합니다. 모델별 비용은 SDK 결과의 `modelUsage[*].costUSD`와 `total_cost_usd`(SDK 내장 정가표 기반 추정치)를 사용합니다.
- SDK 가격표에 없는 모델(`costBasis: unknown`)은 `~/.cvp/config.json`의 `pricing`에 단가를 넣었을 때만 추정하고, 단가가 없으면 임의로 계산하지 않습니다.
  ```json
  { "pricing": { "<model-id>": { "input": 4, "output": 20 } } }
  ```
- 예산 적용(이중):
  1. 세션 누적 예상 비용이 한도 이상이면 CLI가 **다음 요청을 보내기 전에** 막습니다.
  2. SDK `maxBudgetUsd`(남은 한도)로 진행 중인 턴도 제한합니다.
- Rate Limit, 과부하, 크레딧 부족 오류는 분류해 원인과 조치를 보여 줍니다. 재시도는 SDK의 재시도 정책을 따르며, 재시도할 때마다 화면에 표시합니다.
- 크레딧 잔액을 조회하는 공식 API가 없으므로 **잔액은 표시하지 않습니다.** Console의 Billing에서 확인하세요.

> ⚠ **CLI의 비용 제한은 실제 청구를 완벽하게 막지 못합니다.** 표시 비용은 정가표 기반 추정치이며, 할인·계약 단가·세금·서버 측 도구 비용·진행 중이던 요청 등으로 실제 청구액과 다를 수 있습니다. 한도는 요청과 요청 사이에서 확인하므로 마지막 요청 하나만큼 넘을 수 있고, 같은 키를 쓰는 다른 프로그램의 지출은 알 수 없습니다. 확실하게 막으려면 Console의 조직/워크스페이스 **Spend limit**을 설정하세요.

## 도구와 권한

모델에는 SDK 내장 도구 `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`(Windows에서는 `PowerShell` 추가)만 제공합니다(`tools` 옵션).

### 권한 모드

| 모드 | 파일 수정 (Edit/Write) | 명령 실행 (Bash/PowerShell) | 위험 명령 |
|---|---|---|---|
| `default` (기본) | 승인 요청 | 승인 요청 | 승인 요청 |
| `acceptEdits` | **자동 승인** | 승인 요청 | 승인 요청 |
| `plan` | 거부 (읽기 전용) | 거부 | 거부 |
| `bypass` | **자동 승인** | **자동 승인** | 승인 요청 (비대화형이면 거부) |

모든 모드에서 작업 디렉터리 안의 읽기·검색은 자동으로 허용되고, 작업 디렉터리 밖의 파일 도구 접근은 거부됩니다.

- 지정: `--permission-mode <모드>` > `CVP_PERMISSION_MODE` > `cvp config set permissionMode <모드>` > `default`
- 대화 중 변경: `/mode <모드>`, 또는 입력 대기 중 **Shift+Tab**으로 `default → acceptEdits → plan` 순환. `bypass`는 실수로 켜지지 않도록 순환에서 빠져 있고, `/mode bypass`로 바꿀 때 한 번 더 확인합니다.
- 프롬프트 앞에 현재 모드가 표시됩니다(예: `[편집 자동승인] >`, `[계획(읽기 전용)] >`).
- `plan` 모드에서는 각 입력에 "수정·실행하지 말고 계획을 제시하라"는 안내를 덧붙여 보냅니다.
- 승인 프롬프트의 응답: `y` 허용, `n` 거부. `a`는 셸 명령이면 같은 명령을 세션 동안 허용하고, 파일 수정이면 `acceptEdits` 모드로 전환합니다. 위험 명령에는 `a`가 없습니다.
- 위험 패턴: `rm -rf`, `git push --force`, `git reset --hard`, `Remove-Item -Recurse`, `sudo`, `curl … | sh` 등
- `-p` 비대화형(stdin이 TTY가 아님)에서는 승인을 받을 수 없으므로, `default`와 `acceptEdits`에서 승인이 필요한 작업은 거부됩니다. 자동화에는 `--permission-mode bypass`를 명시하세요. 이때도 위험 명령은 거부됩니다.
- 작업 디렉터리 밖을 허용하려면 `cvp config set additionalDirectories <dir1,dir2>`

**격리 수준 구분**

- *애플리케이션 수준 제한*(항상 적용): `PreToolUse` 훅과 `canUseTool`이 파일 도구의 경로를 확인합니다(심볼릭 링크 해석, Windows 대소문자 구분 없음). 하지만 **셸 명령 안에서 바깥 경로에 접근하는 것까지는 막지 못합니다.** 그래서 셸 명령은 매번 사용자 승인을 받습니다.
- *SDK 샌드박스*(OS 수준, 선택): `cvp config set sandbox true`로 SDK `sandbox` 옵션을 켭니다. Linux(bubblewrap)와 macOS에서만 동작하고 **Windows는 지원하지 않습니다.** 지원되지 않는 플랫폼에서는 비활성 상태로 실행됩니다(`failIfUnavailable: false`).

## 세션

세션 기록은 SDK가 `~/.cvp/agent/projects/` 아래에 저장하고, `listSessions()`, `resume` 옵션으로 목록 조회와 재개를 합니다. 세션별 사용량 원장은 `~/.cvp/usage/<session-id>.json`에 저장됩니다.

## 테스트

```bash
npm test          # 빌드 + 단위 테스트 + Mock API 통합 테스트
```

통합 테스트는 `test/mock-server.mjs`(테스트 전용 로컬 Mock Messages API)를 `ANTHROPIC_BASE_URL`로 지정해 실제 `cvp` 바이너리 → Claude Agent SDK → Mock API 전체 경로를 검증합니다. 실제 API 검증은 `cvp verify`로 수행합니다.
