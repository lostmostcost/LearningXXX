# Common environment and collaboration

## 앱 변경과 CLI를 함께 개발하는 순서 (WBS-110)

새 기능이나 사용자 동작을 바꾸는 수정은 다음 순서로 진행합니다. 상세 의무는 [AGENTS.md](../AGENTS.md#mandatory-app-and-cli-co-development), 명령과 모드 계약은 [SPEC-007](specs/SPEC-007.md)을 따릅니다.

1. **사용자 흐름 정의:** 진입 화면부터 탐색·선택·확인·결과까지의 순서와 영향 있는 실패·취소·재시도·재시작 경우를 정합니다.
2. **CLI 검증 시나리오 선행:** debug에서 그대로 수행할 단계와 assist가 생략할 수 있는 탐색 단계를 먼저 정합니다. 작업 기록이나 관련 기존 테스트에 남기면 되며, 앱 구현 전에 CLI 전체를 완성하거나 매번 새 테스트 파일을 만들 필요는 없습니다.
3. **앱·CLI 공동 구현:** 같은 작업에서 실제 앱 동작과 필요한 명령·검증·시나리오·문서를 함께 유지합니다. 일반 버튼·문구·배치는 동일 renderer를 통해 자동 반영될 수 있으므로 확인 후 CLI 코드를 그대로 둘 수 있습니다. 새 조작 방식·화면·assist 단축은 명시적인 지원 추가가 필요한지 확인합니다. 제품 동작과 시각 UI를 별도로 복제하지 않습니다.
4. **영향에 맞는 검증과 기록:** debug로 실제 사용자 순서를 확인하고, assist 변경은 단축의 결과와 경계를 별도로 검사합니다. 필요한 시각 자료는 같은 renderer의 배경 PNG로 생성합니다. fixture/local·flow·실행 명령/결과·미검증 범위를 기록하며 assist 통과를 debug 통과로 대체하지 않습니다. native 권한·학교 로그인 등은 `NATIVE_REQUIRED`로 남기고 성공으로 표시하지 않습니다.

작은 문구·색상·스타일 수정은 **앱 수정 → 관련 기존 CLI 흐름/PNG 확인**으로 충분합니다. 모든 앱 변경에서 CLI 영향 여부를 평가하되, 불필요한 CLI 코드 수정·새 테스트·전체 검사·사람 QA를 추가하지 않습니다. 작업/리뷰 완료 기록에는 `CLI 영향 / 함께 바꾼 지원 / 실제 검사 / 남은 제한`을 남깁니다. 문서만 고치는 등 CLI 영향이나 검사가 없는 경우에는 그 이유를 적습니다. 필요한 CLI 지원을 빼놓은 채 해당 기능을 완료 처리하지 않습니다.

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

assist에서 `{"op":"catalog"}`로 과목과 현재 자료 ID를 읽은 뒤 `{"op":"navigate","courseId":"목록의 UUID","resourceId":"자료의 UUID","tab":"memo"}`처럼 바로 이동할 수 있습니다. `section`은 home/book/info/tasks/notice/media, `tab`은 chat/memo/recording/transcripts입니다. debug는 이 두 명령을 거부합니다. assist 결과에는 flow/단축 사용 횟수가 남으며 사용자 여정 검증의 통과 근거로 쓰지 않습니다. 제출·삭제·권한 등은 단축하지 않습니다. 이 CLI는 실행한 세션을 제어하며 기존 일반 앱 채팅에 자동 연결되는 도구 등록은 포함하지 않습니다.

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

## Parallel work claims (optional)
The repository (docs/pm/wbs.json) is the task list; the old Notion board is archived. Claims are needed only when another person or agent works in this repository at the same time:

```sh
git fetch origin
python3 scripts/claim.py acquire WBS-001
git switch -c fix/WBS-001-short-name origin/main
```

The command reads the task's areas from docs/pm/wbs.json and atomically creates task and area refs; a competing claim fails without partial locks. Read current locks: `git ls-remote origin 'refs/heads/claims/*'`. Local receipts are in Git's common directory under learningxxx-claims. Release after merge or handoff with `python3 scripts/claim.py release WBS-001`; release cannot remove a newer owner's claim. Never force-steal a claim. This is coordination between trusted writers, not a security boundary.

`python3 scripts/check_scope.py WBS-001 origin/main` lists committed paths outside the task's `paths`; use it as a review aid and update `paths` when a change legitimately grows.

## Completion
Self-review + passing CI → the agent merges its own PR (squash; main requires `project-checks` and linear history). The agent verifies in the real app or with real engines/services when the change is observable there and records what stayed unverified; the owner's own hands-on test is optional.
Package checks do not by themselves establish successful real LMS/Claude calls, microphone capture or transcription quality. WBS-109 adds explicit background renderer checks; it does not replace those native/service checks.

## 전역 패널과 녹음·전사 화면 (WBS-111)
상단 채팅/메모는 독립 토글이며 닫거나 화면을 옮겨도 채팅 초안과 요청을 유지한다. 녹음·전사는 좌측 버튼의 독립 화면이다. `tab: recording/transcripts` assist 요청은 그 화면의 호환 별칭이며 두 개의 우측 탭을 만들지 않는다. 화면 문맥 표시와 대화 소속은 구분하며 화면 이동으로 세션을 자동 재배정하지 않는다.

레이아웃 사용자 흐름 확인: `node apps/desktop/host/scripts/layout-smoke.mjs`, `node apps/desktop/host/scripts/layout-smoke.mjs --assist`. 출력된 private 임시 경로에서 trace와 배경 PNG를 확인한다. fixture는 UI 흐름 증거이며 실제 녹음·전사·Claude 동작의 증거로 쓰지 않는다.


## Claude 업데이트와 텍스트 작업 (WBS-113)
정리본·번역 등의 단발 작업은 파일 도구 없는 text 프로필을 쓴다. 새로운 CLI 바이너리의 최초 작업에서 합성 호환성을 자동 확인하고 성공 metadata를 `<앱 데이터>/cli-text-compatibility`에 보관한다. 업데이트/바이너리/검사 정책이 바뀌면 자동 재검사한다. 로그인·구독 한도·연결 오류는 별도로 표시하고 검사 실패를 통과로 저장하지 않는다. 최초 확인에는 소량의 구독 사용량과 추가 시간이 들며 앱 시작/업데이트만으로 모델 요청을 보내지 않는다.

`packages/cli-adapter/src/text-compatibility.ts`의 검사 또는 스트림 해석을 바꾸면 TEXT_COMPAT_POLICY revision도 올린다(flags는 해시에 포함). 검증 metadata에 사용자 텍스트·인증/원시 응답을 넣지 않는다. 재확인이 필요하면 해당 private 캐시 JSON만 지울 수 있으며 다음 작업에서 다시 검사한다. legacy independent/app_modify 버전 목록과 기존 G0 증거를 이 캐시로 확장하지 않는다. 일반 SDK/native 채팅의 환경·권한 정책도 별개다.

실제 합성 확인: `node --experimental-strip-types apps/desktop/host/scripts/text-compat-smoke.ts`. 별도 임시 캐시를 사용하며 구독 사용량을 소량 쓴다. API/provider 환경 검사를 우회하지 않는다. 사용자 강의는 보내지 않으며, 결과는 CLI 엔진 확인과 UI fixture 검사로 각각 기록한다.
