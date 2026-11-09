# Common environment and collaboration

## AI의 텍스트 기반 앱 검증 (WBS-109)

macOS에서 Node 24와 기존 의존성/Electron 설치가 필요합니다. 이 명령은 설치·네트워크 접근 없이 로컬 도구로 UI와 host를 빌드하고 **창을 표시하지 않는** 세션을 시작합니다.

```sh
node apps/desktop/host/scripts/app-control.mjs
```

표준입력에 JSON을 한 줄씩 보냅니다. 첫 응답의 `snapshot.controls`에서 이름·context·disabled를 읽고 **그 응답의 ID**로 조작합니다. 예를 들어 과목 선택 버튼 ID가 `revision:0`이면 다음과 같습니다(실제 응답 ID로 바꾸세요).

```json
{"op":"click","target":"revision:0"}
```

매번 새 snapshot의 ID를 사용합니다. 메뉴를 연 뒤 과목을 선택하고, 주차 트레이를 연 뒤 자료를 선택하는 순서를 지킵니다. 빈 전송 버튼이나 닫힌 메뉴를 우회할 수 없습니다. 상태를 다시 읽을 때는 `{"op":"snapshot"}`, 화면 자료가 필요할 때는 `{"op":"render","name":"course-pdf"}`, 끝낼 때는 `{"op":"stop"}`을 보냅니다. 성공한 render 응답의 `evidence.image`에 PNG, 같은 폴더에 JSON 근거가 있습니다.

```sh
# 공개 CLI 사용자 흐름 회귀(합성 데이터만)
node apps/desktop/host/scripts/app-control-smoke.mjs
# 실제 preload/IPC·설정 저장: 새 빈 테스트 프로필, 계정 입력 없음
node apps/desktop/host/scripts/app-control-smoke.mjs --local
# 프로필을 유지해 재시작/저장 상태를 확인하려면: 경로는 새로 만들 이름을 지정
node apps/desktop/host/scripts/app-control.mjs --mode local --profile /tmp/yolo-agent-profile
```

코드 테스트는 기본 `--flow debug`를 사용합니다. 앱 조작용 에이전트가 메뉴를 건너뛰고 탐색하려면 `--flow assist`를 명시합니다. 두 flow는 데이터 모드(`fixture`/`local`)와 독립적입니다.

```sh
node apps/desktop/host/scripts/app-control.mjs --flow assist
node apps/desktop/host/scripts/app-control-smoke.mjs --assist
```

assist에서 `{"op":"catalog"}`로 과목과 현재 자료 ID를 읽은 뒤 `{"op":"navigate","courseId":"목록의 UUID","resourceId":"자료의 UUID","tab":"memo"}`처럼 바로 이동할 수 있습니다. `section`은 home/book/info/tasks/notice, `tab`은 chat/memo/recording/transcripts입니다. debug는 이 두 명령을 거부합니다. assist 결과에는 flow/단축 사용 횟수가 남으며 사용자 여정 검증의 통과 근거로 쓰지 않습니다. 제출·삭제·권한 등은 단축하지 않습니다. 이 CLI는 실행한 세션을 제어하며 기존 일반 앱 채팅에 자동 연결되는 도구 등록은 포함하지 않습니다.

기본 `fixture`는 실제 UI 코드와 합성 서비스를 씁니다. 실제 LMS·Claude·녹음 검증과 구분하세요. `local`은 전용 프로필의 실제 host를 씁니다. 마이크·파일 선택·학교 로그인·외부 창은 `NATIVE_REQUIRED`로 멈추며 별도 실제 앱 확인이 필요합니다. 일반 앱 프로필을 복사하거나 CLI에 넘기지 마세요. 자세한 명령·증거·제약은 [SPEC-007](specs/SPEC-007.md), 검토/검사 결과는 [WBS-109 리뷰](pm/reviews/WBS-109.md)에 있습니다.

사용자 지시로 GitHub를 보존하는 로컬 작업에서는 원격 claim을 생성/삭제하지 않습니다. WBS-109는 기존 claim 도구의 `acquire(..., remote=<local .git>)`로 task/host/ui/shared ref를 create-only 방식으로 확보했고 로컬 receipt로 해제합니다. 일반 협업의 원격 claim 절차는 아래에 그대로 보존합니다.

## Environment
Install Docker Desktop and host Git/Python 3.12+. Run `docker compose run --rm tools`.
The checks validate planning/tooling and package tests/builds. Native macOS permissions, real LMS/Claude behavior and recording quality need their own evidence. The current product runtime is Electron + React (ADR-002).
No personal Claude/LMS credentials or host home mount is used.
Mac host checks: macOS/CPU, official CLI version, subscription login, microphone, keychain, UI execution.
These checks are WBS-001/002/005, not passed by the repository bootstrap.

The initial image pins the Python patch tag and multi-platform base digest. Apt packages are installed from Debian repositories; the image build is not a complete reproducible-build guarantee. WBS-005 must record the final built image digest for both developers and pin service dependencies after the stack decision.
The devcontainer uses the same read-only source mount for checks; edit source on the host. A writable app development service is added after the stack decision.

## Atomic work claims
Notion is not an atomic lock. On the host, after checking live Ready/dependencies:

```sh
git fetch origin
python3 scripts/claim.py acquire WBS-001 --ready-confirmed
git switch -c spike/WBS-001-cli-proof origin/main
```

The command reads allowed areas from docs/pm/wbs.json and atomically creates task and area refs with empty expected values. All refs must be absent. A competing claim fails without partial locks. The unique claim commit records Git identity, task, timestamp and nonce. This is coordination between trusted repository writers, not a security boundary against malicious collaborators.

Update Notion owner/start/branch after success. Each person should hold one implementation task.
Read current locks: `git ls-remote origin 'refs/heads/claims/*'`.
Local receipts are in Git's common directory under learningxxx-claims, shared by worktrees. Preserve the receipt until release. If network response is uncertain, retain it and inspect remote refs before retrying; never force-steal.

After appropriate checks/merge (and developer self-testing at major feature checkpoints), or a documented handoff:
```sh
python3 scripts/claim.py release WBS-001
```

Release deletes all recorded refs atomically with an expected-SHA lease; it cannot remove a newer owner's claim. No expiry or automatic takeover. A lost clone/receipt requires an explicitly coordinated manual recovery by both humans.

The script does not synchronize Notion or verify live Ready/dependency state: `--ready-confirmed` is your explicit acknowledgment after reading Notion, not an automated gate.
Changing task areas requires a shared planning change first. Keep edits inside the WBS paths. An out-of-area edit is an approved exception only (OPS-001 영역 밖 예외): minimum files, recorded in `paths`/`scope_note` and the PR, the claim holder informed, and a thorough pre-merge check (fresh main, line-by-line review of out-of-area diffs, regenerated generated files, full container checks with the frozen lockfile, fresh clone, scope check). Check a branch's allowed paths:
```sh
python3 scripts/check_scope.py WBS-001 origin/main
```
Include uncommitted/untracked paths in review; the scope script checks committed branch differences only.
Shared root/config changes use a shared task; unrelated directories do not imply permission to change shared APIs.

## Completion
Self-review + passing CI → author may merge their own PR. Routine tasks then proceed to Done without QA cards or peer QA. Only major feature checkpoints WBS-020/028/031 require the responsible developer to directly test the feature and record a brief self-QA result. No peer approval is needed; WBS-029 summarizes existing results.
Notion dates, assignees and QA outcomes are blank until real work occurs.
Package checks do not by themselves establish successful real LMS/Claude calls, microphone capture or transcription quality. WBS-109 adds explicit background renderer checks; it does not replace those native/service checks.

