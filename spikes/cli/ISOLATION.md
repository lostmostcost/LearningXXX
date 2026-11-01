# WBS-002 · 독립 세션 접근 경계 검증 결과

- Spec/REQ: SPEC-002 v0.1.1 · REQ-005
- 기준 commit: `0ec546e`
- 환경: macOS 27.2, arm64, Claude Code 2.1.316, 구독 Pro, 모델 alias `haiku`
- 실행일: 2026-11-01 · 실행 2회 (`evidence/2026-11-01-isolation1.json`, `isolation2.json`)
- 결과: 2회 모두 PASS. 모든 호출이 `apiKeySource: none`
- 사람 QA: NOT RUN

## 결론

구독 로그인을 유지하면서 독립 세션의 문맥과 파일 접근을 막을 수 있다. 이 격리는 프롬프트 문구가 아니라 아래 플래그로 만든다.

```text
claude -p <prompt> --restricted --safe-mode --strict-mcp-config
  --disable-slash-commands --permission-mode dontAsk
  --tools Read,Glob,Grep --session-id <새 UUID>
```

`--bare`는 구독 로그인을 쓰지 않으므로 대상에서 제외했다.

**조건:** 이 경계는 CLI가 강제하며 OS가 강제하지 않는다. SPEC-002는 CLI 권한 설정을 보안 경계로 가정하지 말라고 하므로, 진행 조건으로 받아들일지는 WBS-004 ADR에서 결정해야 한다. 이번 결과는 "실수와 자동 문맥 유입을 막는다"는 근거이고, 악의적 우회를 막는다는 근거가 아니다.

## 측정 방법

일회용 프로젝트의 누출 경로마다 고유 canary를 심고, 모델 답변이 아니라 다음을 확인했다.

- stream 이벤트 전체와 저장된 transcript의 canary
- 실제 tool 호출과 거부 횟수
- hook, MCP 서버가 실행될 때 남기는 marker 파일
- 파일시스템 변경

격리 없는 대조군에서 canary가 나오지 않으면 결과를 무효(INCONCLUSIVE)로 처리한다.

## 결과

| 누출 경로 | 대조군 | 격리 세션 |
|---|---|---|
| 부모 `CLAUDE.md` | 노출 | 차단 |
| 자동 기억 (`MEMORY.md`) | 노출 | 차단 |
| 프로젝트 hook | 실행, 노출 | 실행 안 됨 |
| 프로젝트 MCP 서버 | 실행 | 실행 안 됨 |
| claude.ai 커넥터 | 도구 자동 연결 | 도구 0개 |

`--setting-sources project`만으로는 커넥터가 막히지 않았다. 대조군에서 Gmail, Drive 같은 개인 계정 도구가 붙었으므로 `--strict-mcp-config`가 필수다. 커넥터 도구 수는 19~60개로 호출마다 달랐다.

| 격리 세션 접근 시도 | 결과 |
|---|---|
| 같은 폴더에 CLAUDE.md, 기억, hook이 있어도 새 세션 시작 | 노출 없음 |
| 절대 경로, `../../` 경로로 과목 파일 읽기 | 거부 |
| 부모 `CLAUDE.md`, 기억 파일 직접 읽기 | 거부 |
| 다른 세션의 대화 기록 폴더 읽기 | 거부 |
| 작업 폴더 안 symlink를 `Read`, `Grep`으로 읽기 | 거부 또는 내용 없음 |
| 첨부 폴더 안 symlink로 밖의 파일 읽기 | 거부 |
| 외부 파일 덮어쓰기, 외부에 새 파일 만들기 | 거부, 파일 변경 없음 |
| `--add-dir`로 명시한 첨부 읽기 | 허용, 다른 canary 없음 |

외부 쓰기는 1회차에서 두 작업을 모두 시도했고, 2회차에서는 모델이 첫 거부 후 멈춰 덮어쓰기만 시도했다. 새 파일 만들기 거부의 관찰은 1회뿐이다.

Bash는 도구 목록에 없다.

## 앱 구현에서 지킬 점

1. 독립 세션은 위 플래그 전체를 코드로 고정한다. 하나라도 빠지면 누출 경로가 생긴다.
2. `--resume`에 과목 세션 ID를 넘기지 않는다. 독립 세션은 항상 새 UUID를 쓴다.
3. 작업 폴더 경로는 UUID 같은 중립적인 이름으로 만든다. 경로 문자열은 세션 환경 정보로 전달될 수 있어, 과목명이 들어가면 그 자체가 문맥이 된다.
4. 첨부는 파일을 빈 폴더에 복사해 `--add-dir`로 넘긴다. 과목 폴더 전체를 추가하지 않는다.
5. 실행 후 init 이벤트의 `tools`, `mcp_servers`, `apiKeySource`를 확인하고, 다르면 세션을 중단한다.
6. 독립 세션의 대화 기록도 `~/.claude/projects/` 아래에 남는다. 격리는 다른 세션의 접근을 막을 뿐 기록을 없애지 않는다.

## 미검증

- **`AGENTS.md`, `CLAUDE.local.md`:** canary를 심었지만 대조군에서도 노출되지 않아 격리 여부를 판단할 수 없다. 격리 세션에서 노출되지 않았다는 사실만 기록한다.
- **사용자 전역 설정:** 실제 `~/.claude`를 건드리지 않기 위해 전역 `CLAUDE.md`, 전역 hook에는 canary를 심지 않았다. 이 Mac에는 전역 `CLAUDE.md`가 없다.
- **내장 플러그인:** 격리 세션에도 `cc-plugin-*` 3개가 남고, 스킬은 0개다. 동작은 분석하지 않았다.
- **격리 세션의 정상 쓰기:** 외부 쓰기 거부만 확인했다. 작업 폴더 안 쓰기와 외부 폴더 선택 흐름은 앱 구현 단계에서 검증해야 한다.
- **기타:** 네트워크 요청 본문 직접 관찰(인증 정보를 프록시에 노출하게 되어 하지 않음), macOS 앱 프로세스 실행, 두 번째 Mac, CLI 버전 변경 후 동작, 악의적 우회.

## 재현

Mac host에서 실행한다. 구독 사용량을 조금 쓴다. 일회용 폴더와, 그 이름으로 된 `~/.claude/projects/` 하위 폴더만 만들고 종료 시 지운다.

```sh
python3.13 -m unittest discover -s spikes/cli
python3.13 spikes/cli/isolation.py --evidence spikes/cli/evidence/<파일명>.json
```

## 작동 구조

- 실행 위치: Mac host의 Python 하네스가 CLI를 호출한다. 서버와 Docker는 쓰지 않는다.
- 자동/수동: 시나리오 실행과 판정은 자동이고, QA 판정과 ADR 결정은 사람이 한다.
- 증거에서 제외: 이메일, 조직 ID, 사용자 이름, 커넥터 이름. 도구는 내장 도구 이름과 MCP 도구 수만 저장한다.
- 실패 시: FAIL이나 INCONCLUSIVE이면 exit 1로 끝나고 증거 JSON의 `reasons`에 이유가 남는다.

## 사람 QA 절차

상대 개발자가 자기 Mac과 자기 구독 로그인으로 진행한다.

1. `env | grep -E 'ANTHROPIC|CLAUDE_CODE_USE'`로 아무것도 안 나오는지 확인한다.
2. 위 재현 명령을 실행한다. PASS가 나와야 한다.
3. 증거 JSON의 `controls`에는 canary가 있고, `isolated`에는 `attachment`의 ATTACH 외에 없는지 확인한다.
4. 증거 JSON에 본인 이메일, 사용자 이름, 커넥터 이름이 없는지 확인한다.

- Actual experience:
- Tester / date:
- Result: NOT RUN
