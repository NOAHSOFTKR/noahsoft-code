# CVP CLI (`cvp`)

Anthropic 공식 **Claude Agent SDK**(`@anthropic-ai/claude-agent-sdk`)로 만든 독립형 터미널 에이전트입니다.
Console API 키(`ANTHROPIC_API_KEY`)로만 인증하며, CVP(Cyber Verification Program) 승인 조직에서 허용된 모델을 CLI에서 쓰기 위한 도구입니다.
기존 Claude Code CLI를 실행하는 래퍼가 아니라, SDK의 `query()` API를 직접 사용합니다.

## 설치

Windows PowerShell에서 설치 스크립트를 내려받아 실행합니다.

```powershell
$installer = Join-Path $env:TEMP 'cvp-install.ps1'
Invoke-WebRequest 'https://raw.githubusercontent.com/NOAHSOFTKR/noahsoft-code/main/install.ps1' -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
```

Node.js 24 이상과 Git for Windows를 확인하고, 없으면 WinGet으로 설치합니다. WinGet이 없는 PC에서는 두 프로그램을 먼저 설치한 뒤 다시 실행하세요. 설치 중 Windows가 관리자 승인을 요청할 수 있습니다.

기본 설치 폴더는 `%LOCALAPPDATA%\Programs\noahsoft-code`, 명령 폴더는 `%LOCALAPPDATA%\Programs\noahsoft-code-bin`입니다. 명령 폴더를 사용자 PATH 앞에 등록하며, **새 터미널**에서 `cvp --version`으로 확인합니다. API 키와 모델은 아래 방법으로 별도 설정합니다.

같은 스크립트를 다시 실행하면 저장소·브랜치와 추적 파일 변경 여부를 확인하고 `git pull --ff-only` 후 다시 빌드합니다. 기존 작업 파일을 강제로 초기화하지 않습니다. 경로 지정은 `-InstallDirectory "C:\Tools\cvp" -BinDirectory "C:\Tools\cvp-bin"`, 선행 프로그램 자동 설치 생략은 `-SkipPrerequisites`, 사용자 PATH 등록 생략은 `-SkipPathUpdate`를 사용합니다.

소스에서 직접 설치할 수도 있습니다.

```bash
git clone https://github.com/NOAHSOFTKR/noahsoft-code.git
cd noahsoft-code
npm ci
npm run build
npm link
cvp
```

수동 설치의 전역 명령 폴더는 Windows에서 `npm prefix -g`, Linux/macOS에서는 그 경로의 `bin` 하위 폴더이며 PATH에 있어야 합니다.

요구 사항: Node.js 24 이상. Windows의 `Bash` 도구에는 Git for Windows(Git Bash)가 필요하며, PowerShell 명령은 Git Bash에서 `powershell.exe`를 호출해 실행할 수 있습니다. 별도 `PowerShell` 도구 노출 여부는 SDK 런타임에 따라 다릅니다.

## 환경변수

`.env.example`을 `.env`로 복사하거나(작업 디렉터리의 `.env`를 자동으로 읽음) 셸에서 설정합니다.

| 변수 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | **필수.** Console(platform.claude.com)에서 발급한 CVP 조직의 API 키 (`sk-ant-api…`) |
| `CVP_EFFORT` | 추론 노력: `low`, `medium`, `high`, `xhigh`, `max`. 미지정 시 SDK 기본 동작 유지 |
| `CVP_MODEL` | 사용할 모델 ID. **기본값 없음**(하드코딩 금지) |
| `CVP_MAX_SESSION_COST_USD` | 세션당 예상 비용 한도. 기본 `1.00` |
| `CVP_EXPECTED_ORG_ID` | (선택) CVP 조직 ID. `cvp verify`가 API 응답 헤더의 조직 ID와 대조 |
| `CVP_HOME` | (선택) 설정·세션·사용량 저장 위치. 기본 `~/.cvp` |
| `CVP_PERMISSION_MODE` | (선택) 기본 권한 모드: `default` \| `acceptEdits` \| `plan` \| `bypass` \| `fullbypass` |
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
cvp --effort high                    # 이번 실행의 추론 노력 지정
cvp config set effort high           # 기본 추론 노력 저장 (해제: cvp config unset effort)
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
| `/ui` | 대화형 작업 모드 켜기·끄기 |
| `/model [id]` | 모델 조회 / 변경 (실제 API 호출로 권한 검증 후에만 적용) |
| `/mode [모드]` | 권한 모드 조회 / 변경 (Shift+Tab으로도 순환) |
| `/models` | 조회 가능한 모델 목록 |
| `/status` | 대화형 상태 패널 숨기기·표시 전환 (파이프에서는 상태 출력) |
| `/usage` | 토큰 사용량·예상 비용·압축/캐시 상태 |
| `/context`, `/autocompact` | 자동 압축 설정 상태·컨텍스트 예상 여유 (조회만) |
| `/cache` | 마지막 요청 캐시 읽기·쓰기 실측과 재사용 추정 |
| `/compact [요약 지침]` | 현재 세션 대화 수동 요약·압축 |
| `/todos` | 부모·서브에이전트의 할 일과 진행도 |
| `/tasks` | 세션의 명령·서브에이전트 작업 목록 |
| `/task <id>` | 작업 상태·결과 조회 |
| `/stop <id>` | 해당 작업 중단 |
| `/clear` | 현재 대화 초기화(새 세션) |
| `/sessions` | 저장된 세션 목록 |
| `/resume [번호\|ID]` | 이전 세션 재개 |
| `/exit` | 종료 |

대화형 터미널은 Ink 기반으로 왼쪽에 대화·입력창, 오른쪽에 상태 패널을 기본 표시합니다. `/status`로 패널을 숨기거나 다시 표시합니다. 상태는 로컬 세션 정보로 갱신하며 화면 갱신만을 위한 모델 API 호출은 하지 않습니다. 폭이 좁은 터미널에서는 패널을 아래에 배치합니다. Tab으로 상태 패널 이동을 선택하고 PgUp/PgDn으로 가려진 항목을 볼 수 있습니다.

모델은 기존 ID로 지정하거나 필드별로 입력할 수 있습니다. 예를 들어 `/model Provider: claude Model-Group: opus Model: 5.5`는 `/model claude-opus-5-5`와 같습니다. 입력창 아래에 제안이 표시되면 Tab으로 채울 수 있습니다. 현재 모델과 `/models`에서 조회한 목록을 후보로 사용하며, 모델 변경 시에만 기존 접근 검증을 실행합니다.

여러 줄 프롬프트에서는 ↑/↓로 화면에 보이는 줄 사이를 이동합니다. 화면 폭 때문에 자동으로 접힌 줄도 포함합니다. 빈 입력창에서 ↑를 누르면 같은 작업 폴더에서 보낸 프롬프트를 불러옵니다. 최근 최대 100개(폴더당 최대 1 MiB)를 `CVP_HOME`의 `prompt-history/`에 일반 텍스트 JSON으로 저장하므로 재실행 후에도 불러올 수 있습니다. 슬래시 명령과 승인 답변은 기록에 포함하지 않습니다. 기록을 탐색하다 최신 항목 아래로 이동하면 입력창이 다시 비워집니다.

마우스 휠이나 PgUp/PgDn으로 대화 기록을 볼 수 있습니다. Windows Terminal에서는 Shift를 누른 채 드래그해 보이는 텍스트를 선택하고 Ctrl+Shift+C로 복사합니다. 기본 키 설정이라면 텍스트를 선택한 상태에서 Ctrl+C로도 복사할 수 있습니다. 선택 없이 Ctrl+C를 누르면 CVP에서 실행 중인 요청이 중단될 수 있습니다.

#### 작업 모드

실행할 때마다 기존 화면이 기본입니다. 대화형 터미널에서 `/ui`를 입력하면 작업 모드와 메뉴가 열립니다. 작업 모드에서 **Alt+M**으로 메뉴를 열고, ↑/↓로 항목을 고른 뒤 Enter로 선택합니다. Esc로 이전 화면에 돌아가고, `/ui`를 다시 실행하거나 메뉴의 **기존 화면 모드로 돌아가기**를 선택하면 원래 화면으로 돌아갑니다.

- **대기 요청**에서는 내용을 확인하고, Enter로 대기열에서 꺼내 입력창에서 편집하거나 Delete로 빼낼 수 있습니다. 꺼낸 요청을 보내려면 평소 전송 키를 다시 누릅니다.
- **프롬프트 기록 검색**은 메뉴 또는 Ctrl+R로 엽니다. 검색어를 입력한 뒤 항목을 고르면 초안으로 불러옵니다. 현재 초안이 있으면 임시 보관됩니다. 메뉴에서 초안을 직접 보관하고 복구할 수도 있습니다. 임시 보관은 이번 실행 동안 유지됩니다.
- **모델 선택**은 메뉴, Alt+P 또는 작업 모드의 `/model`로 엽니다. 현재 모델과 이번 실행에서 최근 전환에 성공한 모델을 먼저 표시합니다. 목록 조회 후 선택한 모델만 기존 호출 검증을 거칩니다. 작업 중 고르면 기존 대기열 순서에 따라 전환을 시도하며 작성 중인 초안은 유지됩니다. `/model <id>`와 구조화 입력도 사용할 수 있습니다.
- **상태 패널**은 남은 예산, 권한, 작업 상태를 보여주는 좁은 요약을 기본으로 사용합니다. 메뉴에서 기존 상세 정보로 전환할 수 있습니다. **대화 기록 크게 보기**에서는 최근 출력 버퍼를 화면 폭 전체로 읽을 수 있으며, ↑/↓·PgUp/PgDn·휠로 이동합니다.

기본 키 동작은 다음과 같습니다.

| 키 | 동작 |
|---|---|
| Enter | 줄바꿈. 단, 한 줄 슬래시 명령은 즉시 실행 |
| Ctrl+Enter | 대기열에 등록하고 현재 작업이 끝나면 순서대로 실행 |
| Shift+Enter | 현재 작업을 중단한 뒤 새 입력을 우선 실행 |

작업 중에도 입력창을 사용할 수 있고 전송 대기 수를 확인합니다. 끼어들기는 중단 응답을 기다린 뒤 우선 실행하며 이미 수행된 파일 수정·명령의 효과를 되돌리지는 않습니다. 키 동작은 설정으로 바꿀 수 있습니다. `newline`은 줄바꿈, `queue`는 대기열 전송, `interrupt`는 중단 후 우선 전송입니다.

```powershell
cvp config set enterAction newline
cvp config set ctrlEnterAction queue
cvp config set shiftEnterAction interrupt
cvp config set slashEnterSubmit true
```

`slashEnterSubmit false`로 설정하면 슬래시 명령에도 Enter의 지정 동작을 적용합니다. 전송할 수 있도록 Enter 계열 키 중 적어도 하나는 `queue` 또는 `interrupt`여야 합니다. 변경은 다음 실행부터 적용하며 `cvp config unset <설정키>`로 각 기본값을 복원합니다.

Windows Terminal 세션에서는 시작할 때 키보드 확장 모드를 바로 켜서 Enter, Ctrl+Enter, Shift+Enter를 구분합니다. 다른 터미널에서는 지원 여부를 자동 감지합니다. Windows Terminal에서 Enter로 보내고 Shift+Enter로 줄을 바꾸려면 다음처럼 설정합니다.

```powershell
cvp config set enterAction queue
cvp config set ctrlEnterAction interrupt
cvp config set shiftEnterAction newline
```

터미널이 Shift+Enter를 구분하지 못하거나 다른 끼어들기 키를 쓰고 싶으면 추가 키를 지정할 수 있습니다. Ctrl+Enter는 기존 설정대로 동작합니다.

```powershell
cvp config set interruptKey ctrl+g
```

`ctrl+k` 또는 `ctrl+u`도 선택할 수 있습니다. 다음 실행부터 적용되며, `cvp config unset interruptKey`로 추가 키를 해제합니다. 승인 질문 중에는 이 키로 전송할 수 없습니다.

Bracketed Paste를 지원하는 터미널에서는 여러 줄 붙여넣기를 하나의 입력으로 모으고 자동 전송하지 않습니다. Ctrl+Enter·Shift+Enter 구분은 터미널 지원과 키 설정에 달려 있습니다. Ctrl+J는 Ctrl+Enter 대체 입력입니다. 승인·확인 질문은 Enter로 답하며 일반 프롬프트 초안과 분리합니다. 파이프 입력에서는 줄 끝의 `\`로 여러 줄을 연결하는 기존 동작을 유지합니다. 실행 중 Ctrl+C는 현재 턴을 중단하고, 대기 중 Ctrl+C 두 번 또는 Ctrl+D는 종료합니다.

응답은 실시간으로 스트리밍되며 Markdown은 완결된 블록 단위로 렌더링합니다. 대화형 화면은 텍스트로 표시하고, 일반 출력에서는 코드 구문 강조를 적용합니다(`--raw`이면 원문 그대로).

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

모델에는 SDK 내장 파일·검색·Bash·Agent·TaskStop 도구를 제공하며, 런타임이 지원하면 PowerShell도 요청합니다. 개별 에이전트·진행도·백그라운드 조회는 아래에 설명한 MCP 도구로 제공합니다.

### 권한 모드

| 모드 | 파일 수정 (Edit/Write) | 명령 실행 (Bash/PowerShell) | 위험 명령 |
|---|---|---|---|
| `default` (기본) | 승인 요청 | 승인 요청 | 승인 요청 |
| `acceptEdits` | **자동 승인** | 승인 요청 | 승인 요청 |
| `plan` | 거부 (읽기 전용) | 거부 | 거부 |
| `bypass` | **자동 승인** | **자동 승인** | 승인 요청 (비대화형이면 거부) |
| `fullbypass` | **자동 승인 (외부 경로 포함)** | **자동 승인** | **자동 승인 (감독 확인 필요)** |

모든 모드에서 작업 디렉터리 안의 읽기·검색은 자동으로 허용됩니다. `fullbypass` 외 모드에서는 작업 디렉터리 밖 파일 도구 접근을 거부합니다.

- 지정: `--permission-mode <모드>` > `CVP_PERMISSION_MODE` > `cvp config set permissionMode <모드>` > `default`
- 대화 중 변경: `/mode <모드>`, 또는 입력 대기 중 **Shift+Tab**으로 `default → acceptEdits → plan` 순환. `bypass`와 `fullbypass`는 실수로 켜지지 않도록 순환에서 빠져 있고, `/mode bypass`로 바꿀 때 한 번 더 확인합니다.
- 프롬프트 앞에 현재 모드가 표시됩니다(예: `[편집 자동승인] >`, `[계획(읽기 전용)] >`).
- `plan` 모드에서는 각 입력에 "수정·실행하지 말고 계획을 제시하라"는 안내를 덧붙여 보냅니다.
- 승인 프롬프트의 응답: `y` 허용, `n` 거부. `a`는 셸 명령이면 같은 명령을 세션 동안 허용하고, 부모의 파일 수정 승인에서는 `acceptEdits` 모드로 전환합니다. 자식 승인에서는 권한 모드를 올리는 선택지를 제공하지 않습니다. 위험 명령에는 `a`가 없습니다.
- 위험 패턴: `rm -rf`, `git push --force`, `git reset --hard`, `Remove-Item -Recurse`, `sudo`, `curl … | sh` 등
- `-p` 비대화형(stdin이 TTY가 아님)에서는 승인을 받을 수 없으므로, `default`와 `acceptEdits`에서 승인이 필요한 작업은 거부됩니다. 자동화에는 `--permission-mode bypass`를 명시하세요. 이때도 위험 명령은 거부됩니다.
- 작업 디렉터리 밖을 허용하려면 `cvp config set additionalDirectories <dir1,dir2>`

**격리 수준 구분**

- *애플리케이션 수준 제한*(`fullbypass` 외 모드): `PreToolUse` 훅과 `canUseTool`이 파일 도구의 경로를 확인합니다(심볼릭 링크 해석, Windows 대소문자 구분 없음). 하지만 **셸 명령 안에서 바깥 경로에 접근하는 것까지는 막지 못합니다.** 셸 명령의 승인 여부는 선택한 권한 모드에 따라 결정됩니다.
- *SDK 샌드박스*(OS 수준, 선택): `cvp config set sandbox true`로 SDK `sandbox` 옵션을 켭니다. Linux(bubblewrap)와 macOS에서만 동작하고 **Windows는 지원하지 않습니다.** 지원되지 않는 플랫폼에서는 비활성 상태로 실행됩니다(`failIfUnavailable: false`).

## 세션

세션 기록은 SDK가 `~/.cvp/agent/projects/` 아래에 저장하고, `listSessions()`, `resume` 옵션으로 목록 조회와 재개를 합니다. 세션별 사용량 원장은 `~/.cvp/usage/<session-id>.json`에 저장됩니다.

## 테스트

```bash
npm test          # 빌드 + 단위 테스트 + Mock API 통합 테스트
```

통합 테스트는 `test/mock-server.mjs`(테스트 전용 로컬 Mock Messages API)를 `ANTHROPIC_BASE_URL`로 지정해 실제 `cvp` 바이너리 → Claude Agent SDK → Mock API 전체 경로를 검증합니다. 실제 API 검증은 `cvp verify`로 수행합니다.

## 서브에이전트

`explorer`(코드 탐색)와 `reviewer`(코드 검토)를 Agent 도구로 호출할 수 있습니다.
예: `cvp -p "explorer 서브에이전트로 프로젝트 구조를 조사하고 결과를 기다려줘"`
또는 대화 중 "reviewer 서브에이전트로 변경 사항을 검토해줘"라고 요청하세요.

두 에이전트는 부모의 현재 모델과 설정한 effort를 사용합니다. Read/Glob/Grep/Edit/Write/Bash와
런타임이 제공하는 경우 Windows의 PowerShell도 요청하며, 부모와 같은 경로 제한·권한 승인 정책을 적용합니다.
에이전트별 최대 12턴이며, 개별 에이전트 툴에서는 `background: true`로 백그라운드 실행할 수 있습니다. 원격 실행·재위임은 지원하지 않습니다.
서브에이전트 API 호출에도 비용이 발생합니다. 기본 Agent 도구의 비용은 SDK 결과에 포함되고, 개별 에이전트 툴의 비용은 완료 시 부모 원장에 합산합니다.

### 개별 에이전트 툴

`cvp --subagent-tools`로 실행하면 기존 Agent 대신 다음 MCP 툴을 모델에 직접 제공합니다.
영구 활성화: `cvp config set subagentTools true` (해제: `cvp config set subagentTools false`).

- `mcp__cvp_agents__spawn_agent`: `{ "role": "explorer", "message": "구조를 조사해줘" }` → 에이전트 ID 즉시 반환
- `mcp__cvp_agents__wait_agent`: `{ "agent_id": "<ID>", "timeout_ms": 10000 }` → 상태·결과 조회, 최대 60초 대기
- `mcp__cvp_agents__send_message`: `{ "agent_id": "<ID>", "message": "추가로 오류 처리를 확인해줘" }` → 실행이 끝나고 재개 가능한 에이전트의 대화를 재개

예: `cvp --subagent-tools -p "spawn_agent로 explorer와 reviewer를 생성하고 wait_agent로 결과를 모아줘"`
실행 중인 에이전트에는 메시지를 보낼 수 없습니다. 먼저 완료를 기다리세요.
에이전트 ID는 현재 부모 실행 안에서만 유효하며, 최대 3개 동시 실행·16개를 보관합니다.
각 실행은 최대 12턴이고 일반 작업은 120초로 제한합니다. `background: true` 작업에는 120초 제한이 없습니다.
일반 작업은 부모 턴 완료·Ctrl+C 시 중단하며, 백그라운드 작업은 유지합니다. `/stop <id>`나 cvp 종료·`/clear`·다른 세션 재개 시에는 함께 정리합니다.
자식은 현재 부모 모델과 effort, 파일·명령 도구와 경로 제한 및 sandbox 설정을 사용합니다.

`spawn_agent`의 선택 필드 `permission_mode`로 AI가 자식 권한을 지정할 수 있습니다.
값은 `plan`, `default`, `acceptEdits`, `bypass`, `fullbypass`이며, 미지정 시 부모의 현재 권한을 동적으로 상속합니다.
권한 순서는 `plan < default < acceptEdits < bypass < fullbypass`입니다. 부모보다 높은 권한 요청은 생성 전에 실패합니다.
예: 부모가 `plan`일 때 `permission_mode: "acceptEdits"`는 거부됩니다.
부모가 `bypass`이면 `{ "role": "explorer", "message": "코드를 수정해줘", "permission_mode": "acceptEdits" }`처럼 낮춰 생성할 수 있습니다.
실행 중 부모 권한을 낮추면 자식도 그 상한을 따르며, `send_message`로 권한을 바꿀 수는 없습니다.

`default`는 수정·명령 승인 요청, `acceptEdits`는 수정 자동 승인·명령 승인 요청,
`plan`은 수정·명령 거부, `bypass`는 일반 수정·명령 자동 승인입니다.
`fullbypass` 외 모드의 위험 명령은 계속 승인이 필요하고, 비대화형에서 승인할 수 없는 요청은 거부됩니다.
부모와 모든 자식의 승인 질문은 하나씩 표시하며, 자식 승인에서 권한 모드를 올릴 수 없습니다.
같은 작업 디렉터리를 공유하므로 부모는 자식별 수정 파일을 나누고 같은 파일의 동시 수정을 피해야 합니다.
셸 명령 내부 경로는 기존과 같이 애플리케이션 경로 검사로 격리되지 않습니다.

서브에이전트별 예산 제한·50:50 배분·예약은 사용하지 않습니다.
부모는 전체 잔여 예산을 사용하며, 완료된 자식 비용·토큰은 부모 원장에 합산합니다.
spawn_agent/send_message/wait_agent 결과의 `remaining_budget_usd`에 남은 세션 예산,
`estimated_session_cost_usd`에 현재까지 집계한 예상 비용을 표시합니다.
진행 중 비용은 제외되므로 `budget_includes_in_flight`는 false입니다.
중단·실패로 최종 사용량을 받지 못하면 비용을 임의로 채우지 않고 `usage_complete: false`로 표시합니다.
`/status`, `/usage`, 매 턴 완료 안내와 `-p --json`에서도 남은 예산을 확인할 수 있습니다.
전체 세션 한도 도달이 확인되면 새 부모 요청과 새 자식 실행은 차단하지만,
이미 실행 중인 자식에는 예산 상한을 적용하지 않으므로 동시 실행 중 전체 한도를 넘을 수 있습니다.
남은 예산은 API 크레딧 잔액이 아닌 CLI 추정치입니다.

### fullbypass와 감독 확인

`fullbypass`는 `bypass`보다 높은 권한 모드입니다. 제공된 도구의 승인 요청을 모두 자동 수락하며,
위험 명령과 작업 디렉터리 밖 파일 읽기·수정도 포함합니다.
다음처럼 **실행마다** 24시간 감독 중임을 명시적으로 확인해야 합니다.

```powershell
cvp --permission-mode fullbypass --supervised
cvp --permission-mode fullbypass --supervised -p "작업 내용"
```

대화 중 `/mode fullbypass`로 전환할 때는 안내를 읽고 `SUPERVISED`를 입력해야 합니다.
설정 파일이나 환경변수에 fullbypass를 저장해도 실행 시 `--supervised`가 없으면 시작하지 않습니다.
프로그램은 실제 감독 여부를 감지하지 않으며 이 값은 사용자의 확인입니다. 기본 모드는 변경하지 않습니다.

부모가 fullbypass이면 자식도 상속하거나 더 낮은 모드로 생성할 수 있습니다.
부모가 bypass 이하이면 자식 fullbypass 생성은 실패하며, 부모 권한을 낮추면 자식도 즉시 제한됩니다.
이 모드가 OS 권한이나 SDK 샌드박스 제한을 해제하지는 않습니다.
API 인증, 비용·예산 한도, 입력 검증, 제공 도구 범위와 재위임 금지는 유지됩니다.

## 실행 프로필

모델·effort·권한 모드·세션 예산·작업 폴더를 이름별로 저장하고 다시 실행합니다.

```powershell
cvp profile save dev --model <model-id> --effort high --permission-mode acceptEdits --budget 5 --cwd "C:\Projects\app"
cvp profile list
cvp profile show dev
cvp profile run dev
cvp profile run dev -p "현재 코드를 분석해줘" --json
cvp profile run dev --model <other-model-id> --cwd "C:\Projects\other"
cvp profile delete dev
```

`save`는 현재 유효한 실행 설정을 저장하며 같은 이름은 갱신합니다.
프로필 실행 시 우선순위는 명령행 옵션 > 프로필에 저장된 값 > 환경변수 > 기본 설정 파일입니다.
작업 폴더를 선택한 뒤 그 폴더의 `.env`를 읽습니다.
파일은 `CVP_HOME`(기본 `~/.cvp`)/profiles/ 아래에 저장되며 API 키와 감독 확인은 저장하지 않습니다.
프로필 자체는 읽기 전에 원래 환경의 `CVP_HOME`에서 찾습니다.
`fullbypass` 프로필도 실행할 때마다 `cvp profile run <name> --supervised`로 감독을 확인해야 합니다.
권한이 높은 프로필을 저장해도 기본 권한 모드는 바뀌지 않습니다.

## 압축·컨텍스트·캐시 상태

자동 압축 설정이나 발동 시점을 변경하지 않고 SDK가 제공하는 상태를 표시합니다.
응답 완료 안내, `/status`, `/usage`, `/context`에서 AutoCompact 켜짐/꺼짐, 압축 중/최근 결과,
현재 컨텍스트와 자동 압축 임계까지의 **예상 여유 토큰**을 확인합니다.
`/autocompact`는 조회 전용이며 설정을 바꾸지 않습니다. 조회할 수 없으면 미확인으로 표시합니다.
컨텍스트는 부모 세션 범위이며 자식의 누적 사용 토큰을 더하지 않습니다.

`/cache`는 마지막 부모 API 요청이 보고한 cache-read/cache-write 토큰을 실측으로,
재사용 가능성과 남은 TTL은 **추정**으로 구분합니다. 읽기 비율은 read / (비캐시 입력 + read + write)입니다.
TTL 메타데이터가 없으면 기본 5분을 가정하고, 실측 1시간 캐시 쓰기만 확인됐을 때만 1시간으로 계산합니다.
혼합 TTL은 보수적으로 5분을 사용하며, 시간 기준은 해당 부모 턴의 전송 시작 시각입니다.
모델 전환·압축 후에는 캐시 재사용 추정을 무효화합니다. 다음 요청의 캐시 적중을 보장하지 않습니다.

SDK의 `getContextUsage({ detail: "summary" })`로 로컬 추정치를 읽으며, 표시를 위한 추가 모델 호출이나
토큰 카운트 API 호출을 하지 않습니다. 일정 시간 안에 조회되지 않으면 미확인 처리하고 해당 세션에서 재조회를 중단합니다.
[SDK 컨텍스트 조회 문서](https://code.claude.com/docs/en/agent-sdk/typescript#sdkcontrolgetcontextusageresponse),
[캐시 TTL 문서](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

### 수동 압축

대화를 시작하거나 기존 세션을 재개한 뒤 다음 명령을 입력합니다. 앞에 점은 붙이지 않습니다.

```text
/compact
/compact 핵심 결정, 변경 파일, 미완료 작업을 보존해줘
```

현재 세션에서 SDK의 내장 압축을 실행하며 세션을 초기화하지 않습니다.
실제 compact_boundary 이벤트를 받은 경우에만 완료로 표시하고, 대화가 부족하거나 실패하면 SDK의 이유를 보여줍니다.
요약 API 호출 비용은 세션 사용량에 반영됩니다. 입력은 슬래시 명령 전송 설정을 따릅니다.

## 백그라운드 작업

cvp가 실행 중인 동안 명령과 개별 서브에이전트를 백그라운드로 돌릴 수 있습니다.
부모가 다른 응답을 수행하거나 입력을 기다리는 동안 계속 실행됩니다. 완료 알림을 처리하는 모델 응답이 발생하면 해당 API 비용도 세션에 집계합니다.

- 명령: 모델이 Bash의 `run_in_background: true`를 사용합니다. Windows PowerShell 명령은 Bash에서 `powershell.exe -NoProfile -Command "..."`를 호출할 수 있습니다. 현재 권한 모드의 명령 승인 정책을 그대로 적용합니다.
- 서브에이전트: `cvp --subagent-tools`에서 `spawn_agent`에 `background: true`를 지정합니다.
- 조회·중단 툴: `mcp__cvp_agents__list_tasks`, `task_status`, `stop_task`를 제공합니다.
- 사용자 명령: `/tasks`, `/task <id>`, `/stop <id>`.

예를 들어 "테스트를 백그라운드로 실행하고 결과를 알려줘" 또는 "탐색 에이전트를 백그라운드로 띄워줘"라고 요청합니다.
에이전트 생성 인자 예시는 다음과 같습니다.

```json
{"role":"explorer","message":"프로젝트 구조 조사","permission_mode":"plan","background":true}
```

완료·실패·중단 상태와 에이전트 결과를 조회할 수 있습니다. 명령 출력 파일이 SDK에서 알려진 뒤에는
마지막 32 KiB까지 표시하며, 결과 알림이 아직 도착하지 않으면 출력이 없을 수 있습니다.
알려진 현재 세션 ID만 조회·중단하며 임의 파일 경로를 출력 조회 인자로 받지 않습니다.

`cvp` 종료, `/clear`, 다른 세션 재개 시에는 작업을 중단합니다. `-p`는 한 번 응답한 뒤 종료하므로
남아 있는 백그라운드 작업을 정리한 상태로 결과를 반환합니다. 터미널을 닫아도 계속 실행하는 데몬 기능은 아닙니다.
백그라운드 에이전트에도 기존 권한 상한과 전체 세션 예산의 집계 방식이 적용됩니다.
실행 중인 비용은 아직 집계되지 않을 수 있고, 이미 실행 중인 자식은 세션 한도를 넘을 수 있습니다.

## 에이전트 todo list

모델에 `mcp__cvp_progress__update_todos`와 `get_todos` 툴을 제공합니다.
에이전트는 여러 단계 작업에서 스스로 목록을 작성하고 다음 상태로 갱신하도록 안내받습니다.

- `pending`: 대기 `[ ]`
- `in_progress`: 진행 중 `[>]`
- `completed`: 완료 `[x]`

목록이 바뀌면 사용자에게 해당 에이전트의 `완료 수/전체 수`와 항목을 표시합니다.
언제든 `/todos`로 부모와 개별 에이전트의 목록을 확인할 수 있습니다.
예: "할 일을 목록으로 만든 뒤 하나씩 진행하면서 상태를 갱신해줘".

부모와 개별 MCP 서브에이전트는 자기 목록만 수정하고, 부모는 전체 진행도를 읽을 수 있습니다. SDK 기본 Agent 도구로 생성한 자식에는 이 MCP 진행도 도구를 제공하지 않습니다.
목록은 `CVP_HOME`(기본 `~/.cvp`)/todos/<session-id>.json에 저장하며 같은 세션 재개 시 복원합니다.
완료 상태는 모델의 보고이며 자동 테스트나 외부 검증의 성공을 보장하지 않습니다.
`-p --json` 결과에도 `runtime_status`, `todos`, `background_tasks`를 포함합니다.

## 외부 MCP 서버

서버는 사용자별 `CVP_HOME`(기본 `~/.cvp`)/mcp.json에 등록되며, 다음 CVP 세션에서 연결합니다.

```powershell
cvp mcp add docs http https://example.com/mcp
cvp mcp add local stdio node C:\tools\mcp-server.mjs --read-only
cvp mcp list
cvp mcp remove local
```

`list`는 등록된 서버 이름과 전송 방식을 표시합니다. 외부 도구는 메인 세션에서만 사용하며, 각 호출에 대화형 승인이 필요합니다. `plan` 모드와 비대화형 실행(`-p`)에서는 호출을 거부합니다. STDIO 서버는 세션 시작 시 로컬 프로그램을 실행하므로 신뢰하는 명령만 등록하세요.

인증이 필요한 HTTP 서버에는 헤더마다 환경변수 이름을 연결하세요. 아래 명령은 현재 셸에 `DOCS_MCP_TOKEN`이 설정되어 있고 값에 `Bearer ` 접두사가 포함되어 있다고 가정합니다.

```powershell
cvp mcp header-env docs Authorization DOCS_MCP_TOKEN
cvp
```

다른 헤더를 추가하려면 같은 명령에 다른 헤더 이름을 지정하세요. 설정 파일에는 환경변수 이름만 저장하며, 값은 CVP 실행 시 읽습니다. 값이 없거나 올바른 HTTP 헤더 값이 아니면 오류를 표시합니다. 인증 헤더는 HTTPS와 로컬 테스트용 루프백 HTTP에서 사용할 수 있습니다.

### 공개 HTTPS 인증 통합 테스트

OpenSSH 클라이언트(`ssh`)와 Pinggy로 나가는 SSH 연결(TCP 443)이 필요합니다. 아래 명령은 저장소 루트에서 실행하세요.

```powershell
npm ci
npm run build
node test/mcp-public-https.mjs
```

스크립트가 Pinggy에 임시 공개 HTTPS 터널을 열고, 별도 CVP 설정에 테스트 서버를 등록합니다. 인증 없는 요청이 HTTP 401로 거부되는지, 임시 환경변수 헤더 두 개로 인증한 뒤 도구 목록 조회와 승인된 호출이 성공하는지 검사합니다. 모델 응답은 로컬 모의 API가 제공하므로 Anthropic API 키나 Pinggy 계정이 필요하지 않습니다. 실행이 끝나면 터널과 테스트 설정을 정리합니다. 외부 네트워크에 의존하므로 일반 `npm test`에서는 실행하지 않습니다.
