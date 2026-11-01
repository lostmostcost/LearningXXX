# @learningxxx/contracts (WBS-006)

renderer·host·collector·CLI adapter가 공유하는 데이터·IPC·오류 계약. 근거: ARCH-001, SPEC-001 v0.1.0(CR-001 로컬 수집), SPEC-002 v0.1.1, SPEC-003 v0.1.2, ADR-002.

| 모듈 | 내용 |
|---|---|
| `common.ts` | `SCHEMA_VERSION`(현재 1), UUID, UTC 시각, sha256, `accountKey`, data root 밖으로 나갈 수 없는 `StorageKey` |
| `errors.ts` | 수집·CLI·host 오류 코드와 `AppError`. 사용자 조치가 필요한 코드는 `retryable: true`를 금지 |
| `lms.ts` | Course, Week, Resource(lms/manual 출처), Asset, AssignmentMetadata, SyncRun, `CollectionManifest`(서버 DeliveryManifest 대체) |
| `sessions.ts` | Session(과목/독립), Run 수명주기, Attachment, ComposerDraft |
| `events.ts` | run 이벤트 envelope 7종과 `checkEventStream` 순서 검사 |
| `ipc.ts` | renderer→host 채널별 request/response schema, host→renderer push, 결과 envelope |

## 규칙
- **버전:** 같은 major 안에서는 선택 필드 추가만 허용한다. 모르는 필드는 제거하고 읽는다. 다른 major는 `parseVersioned`가 `SCHEMA_VERSION_UNSUPPORTED`(앱 업데이트 필요)로 돌려준다. 필드 삭제·의미 변경은 major를 올리고 CR을 남긴다.
- **host가 다시 검증한다.** renderer의 검증은 편의 기능이며 경계가 아니다(ADR-002).
- **독립 세션에는 courseId 필드가 없다.** 지금 보고 있는 과목은 UI 상태일 뿐이다. 작업 폴더는 `sessions/<uuid>`로 만든다(WBS-002 #3). `session.create`의 독립 모드 요청은 courseId를 넣으면 거부한다.
- **`run.started.apiKeySource`는 `"none"`만 통과한다.** 다른 값은 구독 로그인 우회로 본다.
- ARCH-001 초안에 이벤트 `seq`를 추가했다. 빠진 이벤트와 순서 뒤바뀜을 감지하기 위해서다.

## Fixture
`tests/fixtures/contracts/`: normal, expired(학교·Claude 로그인 만료), interrupted(일부 실패·중단·취소), other-account(같은 LMS 과목을 다른 계정이 수집한 경우), invalid(거부되어야 할 10개 사례). 모두 합성 데이터이며, 테스트가 이메일·학번 형태·인증 문자열·`.test`가 아닌 URL이 없는지 검사한다.

## 실행
`docker compose run --rm tools` (lockfile 그대로 설치 후 `tsc` + `node --test`). host에 Node가 있으면 `pnpm install && pnpm -r run check`.
