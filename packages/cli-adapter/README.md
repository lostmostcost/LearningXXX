# @learningxxx/cli-adapter (WBS-014)

공식 Claude Code CLI를 구독 로그인으로 한 번 실행하고, stream-json 출력을 `@learningxxx/contracts`의 run 이벤트로 바꾸는 host 내부 모듈. 근거: SPEC-002 v0.1.1, ARCH-001, ADR-002 결정 5, WBS-001/002 스파이크 결과.

| 모듈 | 내용 |
|---|---|
| `policy.ts` | 모드별 고정 인자 배열, 금지 환경변수, 검증된 CLI 버전(`infra/dev/toolchain.json`과 같아야 함) |
| `locate.ts` | Finder 실행 앱용 `claude` 절대 경로 탐지, 실행 전 점검(`--version`, `auth status`) |
| `run.ts` | `startRun`: 실행, init 검사, 이벤트 정규화, 도구 범위 감시, 취소 |
| `classify.ts` | 실패 신호를 SPEC-002 오류 코드와 사용자 설명으로 변환 |

## 흐름
1. host가 `locateCli`로 경로를 찾고 `probeCli`로 버전과 로그인 방식(`claude.ai`/`firstParty`)을 확인한다. 모델 요청은 보내지 않는다.
2. `startRun`이 요청을 검사한다. API 키류 환경변수가 있으면 프로세스를 띄우지 않고 `FORBIDDEN_CREDENTIAL_ENV`로 끝낸다.
3. CLI를 셸 없이 인자 배열로 한 번 실행한다. 프롬프트는 인자가 아니라 stdin으로 보낸다. `-`로 시작하는 프롬프트도 플래그가 되지 않는다.
4. CLI의 init 이벤트를 검사한다: `apiKeySource: none`, 도구 목록이 모드별 목록과 정확히 같음, MCP 서버 0개, 요청한 session ID, 독립 세션은 검증된 CLI 버전. 하나라도 다르면 프로세스를 멈추고 `run.started` 없이 오류를 돌려준다.
5. 통과하면 `run.started`부터 이벤트를 차례로 내보낸다. 모든 이벤트는 내보내기 전에 계약 schema로 검사한다.
6. 끝은 `run.completed`, `run.failed`, `run.cancelled` 중 하나다. 재시도나 다른 인증 경로로의 전환은 없다.

## 모드별 실행 인자
- 공통: `-p --output-format stream-json --verbose --include-partial-messages`, 새 대화는 `--session-id <uuid>`, 이어가기는 `--resume <uuid>`, 첨부 폴더는 `--add-dir`.
- 독립 세션: ISOLATION.md의 전체 조합 `--restricted --safe-mode --strict-mcp-config --disable-slash-commands --permission-mode dontAsk --tools Read,Glob,Grep`. 작업 폴더 이름은 UUID여야 한다.
- 과목 세션: `--restricted --strict-mcp-config --permission-mode dontAsk --tools Read,Glob,Grep,Write,Edit`. Bash는 없다. 작업 폴더의 CLAUDE.md는 쓸 수 있도록 `--safe-mode`를 넣지 않는다.

## 도구 범위 감시
`tool.requested`의 `decision`은 host가 계산한다. 작업 폴더와 첨부 폴더 밖(symlink 해석 포함)이거나 허용 목록에 없는 도구는 `denied`다. CLI가 이 요청을 실제로 성공시키면 실행을 멈추고 `ISOLATION_VIOLATION`(독립) 또는 `SCOPE_VIOLATION`(과목)으로 끝낸다. 이벤트에는 절대 경로 대신 `notes/a.md`, `attachment-0/…`, `<outside>`만 담는다. 작업 폴더 안에서 성공한 Write/Edit는 `artifact.created`로 알린다.

## 오류
| 상황 | 코드 | 시점 |
|---|---|---|
| CLI 없음, 실행 권한 없음 | `CLI_NOT_INSTALLED` | 시작 전 |
| API 키·공급자 환경변수, init의 `apiKeySource`가 `none`이 아님 | `FORBIDDEN_CREDENTIAL_ENV` | 시작 전 |
| 로그인 없음·만료, `auth status`가 `claude.ai`가 아님 | `CLI_AUTH_REQUIRED` | 점검 또는 실행 중 |
| 사용량 한도 | `USAGE_LIMIT` (`retryable`, 알면 `retryAfter`) | 실행 중 |
| 없는 session ID | `SESSION_NOT_FOUND` | 시작 전 |
| 모르는 옵션, 독립 세션의 미검증 버전 | `CLI_VERSION_MISMATCH` | 시작 전 |
| 도구·MCP·session ID 불일치, 범위 밖 접근 성공 | `ISOLATION_VIOLATION` / `SCOPE_VIOLATION` | 시작 전 또는 실행 중 |
| 시작 전 취소 | `RUN_INTERRUPTED` | 시작 전 |
| 그 밖의 비정상 종료 | `INTERNAL` | 실행 중 |

`retryable`은 사용자가 나중에 다시 보낼 수 있다는 뜻이며, adapter가 자동으로 다시 실행하지 않는다.

## 취소
`AbortSignal`을 받으면 프로세스 그룹에 SIGTERM을 보내고, `killGraceMs`(기본 3초) 뒤에도 살아 있으면 SIGKILL을 보낸다. `run.cancelled`에는 프로세스 종료 여부와, 이번 실행이 쓴 파일 중 아직 남아 있는 목록을 담는다. 되돌리기는 하지 않는다.

## 데이터와 위치
- 실행 위치: 각자의 Mac에서 앱 host(Electron main) 안. 서버와 Docker는 쓰지 않는다. 테스트만 컨테이너에서 가짜 CLI로 돈다.
- 인증 정보는 CLI와 macOS가 관리한다. adapter는 키 값을 읽거나 기록하지 않고, 금지 변수는 이름만 보고한다. `auth status`의 이메일과 조직 정보는 버린다.
- 진단(`onDiagnostic`)은 stderr와 해석하지 못한 출력이다. 홈과 작업 폴더 경로는 가린다. renderer로 보내는 이벤트에는 넣지 않는다.
- CLI 대화 기록은 CLI가 `~/.claude/projects/` 아래에 남긴다. adapter는 이를 편집하지 않는다.

## 범위 밖
세션 매핑 저장, 단일 실행 잠금, requestId 중복 방지, 앱 재시작 시 `interrupted` 복구는 host(WBS-015) 몫이다. 첨부 파일 복사와 외부 폴더 선택은 이후 작업이다.

## 검증
- `docker compose run --rm tools`: 가짜 CLI(`test/fake-claude.mjs`)로 정상, 실패 경로별 오류 코드, 격리·범위 위반, 취소(SIGTERM·SIGKILL), 경로 탐지, 점검을 실제 하위 프로세스로 시험한다.
- 가짜 CLI의 출력 형태는 2026-11-01 Mac에서 Claude Code 2.1.316 실제 호출로 확인했다: stdin 프롬프트, 격리 플래그와 `--resume`, 과목 모드 인자의 init 도구 목록, partial message, Write 결과.
- 미검증: 실제 로그인 만료·사용량 한도 출력 문구(가짜 CLI 문구는 추정), Electron 앱 프로세스에서의 실행, 2.1.316 외 버전.
