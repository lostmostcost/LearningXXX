# WBS-001 · 구독 CLI·파일·재개 스파이크 결과

- Spec/REQ: SPEC-002 v0.1.0 · REQ-001, REQ-004
- 기준 commit: `0c6f293`
- 환경: macOS 27.2, arm64, Claude Code 2.1.316, 구독 Pro, 모델 alias `haiku`
- 실행일: 2026-11-01 · 실행 2회 (`evidence/2026-11-01-run1.json`, `run2.json`)
- 결과: 3개 시나리오 모두 2회 통과. 성공 호출 14회, 전부 `apiKeySource: none`
- 사람 QA: NOT RUN

## 결론

공식 CLI는 구독 로그인만으로 비대화형 요청/응답, 일회용 fixture 생성·수정·삭제, session ID 재개를 수행한다. 앱 host가 호출마다 프로세스를 새로 띄워도 session ID로 대화가 이어진다.

단, 이 결과는 터미널에서 실행한 것이다. 실제 macOS 앱 실행 문맥은 검증하지 않았다.

## 시나리오

| 시나리오 | 판정 방법 | 결과 |
|---|---|---|
| 요청/응답 | 호출마다 다른 토큰을 정확히 돌려주는가 | 통과 |
| 생성·수정·삭제 | 하네스가 디스크의 파일 내용과 존재 여부를 직접 확인, 옆 파일 해시 불변 | 통과 |
| 재개 | 프로세스 종료 후 `--resume`으로 코드워드 회상, session ID 동일, 새 세션은 모름 | 통과 |

## 실패 경계 (관찰값)

| 상황 | 관찰된 동작 |
|---|---|
| 없는 session ID로 재개 | exit 1, `error_during_execution`, stderr `No conversation found with session ID` |
| `ANTHROPIC_API_KEY`가 있음 | **구독 로그인보다 키가 우선**. `apiKeySource: ANTHROPIC_API_KEY`, 가짜 키라 `Invalid API key`로 실패 |
| CLI 미설치 | 프로세스 시작 단계에서 실패, 요청 전 차단 |

앱 구현에서 지킬 점:

1. 실행 전에 API 키와 클라우드 공급자 환경변수를 검사해 막는다. 진짜 키가 있으면 오류 없이 유료 API로 실행될 수 있다. 하네스의 `FORBIDDEN_ENV`가 이 검사의 초안이다.
2. 실행 후 init 이벤트의 `apiKeySource`가 `none`인지도 확인한다.
3. 성공 판정에 `subtype`만 쓰지 않는다. 가짜 키 실패는 `subtype: success`이면서 `is_error: true`, exit 1이었다.
4. 재개는 같은 작업 디렉터리에서 실행했다. 다른 디렉터리에서의 재개는 검증하지 않았으므로 session 매핑에 workspace를 함께 저장한다.

## 실행 설정

```text
claude -p <prompt> --model haiku --output-format stream-json --verbose
  --strict-mcp-config --setting-sources project --permission-mode dontAsk
파일 작업: --tools Read,Write,Edit,Bash
          --allowedTools Read Write Edit "Bash(rm fixture.txt)"
```

Bash는 정확한 명령 하나만 허용했다.

## 재현

Mac host에서 실행한다. 구독 사용량을 조금 쓰고, 일회용 임시 폴더만 수정한다.

```sh
python3.13 -m unittest discover -s spikes/cli
python3.13 spikes/cli/spike.py --evidence spikes/cli/evidence/<파일명>.json
```

API 키류 환경변수가 있거나 로그인 방식이 `claude.ai`가 아니면 하네스는 호출 전에 중단한다. 의도적인 예외로, 실패 경계 측정 한 번은 가짜 키를 넣어 호출한다.

## 작동 구조

- 실행 위치: Mac host의 Python 하네스가 CLI를 실행하고, CLI가 Claude와 통신한다. 서버와 Docker는 쓰지 않는다.
- 읽고 쓰는 파일: 임시 폴더의 `fixture.txt`, `keep.txt`(종료 시 폴더 삭제), `spikes/cli/evidence/*.json`.
- 남는 파일: CLI 대화 기록이 임시 폴더 경로 이름으로 `~/.claude/projects/` 아래에 남는다. 내용은 테스트 문구뿐이다.
- 증거에서 제외: 이메일, 조직 ID, 인증 토큰. `auth status`는 허용 목록 필드만 저장하고 경로는 가린다.
- 자동/수동: 시나리오 실행과 판정은 자동이고, QA 판정은 사람이 한다.
- 실패 시: 시나리오가 실패하면 exit 1로 끝나고 증거 JSON에서 원인을 본다.

## 미검증

- 로그인 만료, usage limit: 실제로 재현하지 않았다.
- 실행 취소, 취소 중 파일 변경, 강제 종료.
- macOS 앱 프로세스에서의 실행.
- 허용하지 않은 명령이 실제로 거부되는지, workspace 밖 경로 접근. 독립 세션 경계와 함께 WBS-002에서 다룬다.
- 다른 디렉터리에서의 재개.
- 두 번째 Mac, 다른 구독 플랜, haiku 외 모델.
- 재개 성공률 수치. 합격 기준은 WBS-003에서 정한다.

## 사람 QA 절차

상대 개발자가 자기 Mac과 자기 구독 로그인으로 진행한다.

1. `env | grep -E 'ANTHROPIC|CLAUDE_CODE_USE'`로 아무것도 안 나오는지 확인한다.
2. 위 재현 명령을 실행한다. 3개 시나리오가 PASS여야 한다.
3. 증거 JSON의 `environment`에서 `auth_method: claude.ai`를 확인한다.
4. 증거 JSON에 본인 이메일이나 집 경로가 없는지 확인한다.

- Actual experience:
- Tester / date:
- Result: NOT RUN
