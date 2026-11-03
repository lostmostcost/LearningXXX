# @learningxxx/collector (WBS-007~010)

## 온라인 영상 원본 다운로드 (WBS-024 / REQ-008)

학교 계정에 직접 제공되는 Commons MP4 원본을 각자의 Mac에서 받는 모듈입니다.
host가 선택한 과목·자료와 로그인 세션의 `fetch`, 계정별 데이터 폴더를 전달합니다.
서버나 외부 전사 서비스로 영상을 보내지 않습니다.

```ts
import { createCommonsVideoResolver, downloadVideo } from "@learningxxx/collector";

const asset = await downloadVideo({
  root: accountDataRoot, courseId, resourceId, sourceId: contentId, title,
  allowedOrigins: ["https://commons.khu.ac.kr"],
  resolveSource: createCommonsVideoResolver({ contentId, fetch: signedInSessionFetch }),
  fetch: signedInSessionFetch,
  signal: abortController.signal,
  onProgress(received, total) { /* total이 없으면 받은 바이트만 표시. 가짜 % 없음. */ },
});
// asset: WBS-022 MediaAsset (role=original, source.type=lms_video)
// WBS-027 host 통합이 이를 영속 등록하고 WBS-025 전사 큐에 자동 연결한다.
```

1. 사용자가 강의를 선택해 요청하면 Commons 메타데이터와 viewer 세션을 새로 확인합니다.
2. HTTPS·명시적 origin 안의 MP4만 스트리밍합니다. 다른 origin, redirect, HTML,
   부분 응답(206), DRM, HLS/DASH·분할 MP4는 우회하지 않고 오류로 표시합니다.
3. `video-tmp/<uuid>.part`에 쓰며 크기(기본 최대 20 GiB), HTTP/원본 크기 정보,
   MP4 box 경계, 비어 있지 않은 영상·샘플 표, 실제 mdat 범위의 chunk offset을 확인합니다.
   전체 프레임 디코딩·코덱 재생 성공이나 서버의 원본 정당성을 보증하는 검사는 아닙니다.
   moov 최대 32 MiB, box 최대 10만, chunk offset 최대 100만 제한이 있습니다.
4. 수신 SHA-256과 디스크 해시가 일치하면
   `video-originals/<sha256 앞 2글자>/<sha256>.mp4`로 생성 전용 확정합니다.
   같은 내용은 재사용하며 다른 버전·기존 손상 파일을 덮어쓰거나 삭제하지 않습니다.
5. 401/403 서명 만료·5xx·연결 중단은 기본 최대 3회 새 메타데이터/주소로 처음부터 받습니다.
   메타데이터 단계의 로그인 만료는 재로그인 안내로 멈춥니다. 매 시도 기본 30분 제한,
   취소는 signal로 전달하며 정상 오류/취소 시 자기 임시 파일만 지웁니다.
   강제 프로세스 종료 시 `.part`가 남을 수 있지만 원본으로 취급하지 않습니다.
   host가 작업 원장을 보존해 재시작 후 재요청·임시 파일 정리를 담당해야 합니다(WBS-027).

URL·서명·쿠키는 반환 MediaAsset이나 로그에 저장하지 않습니다. `sourceId`는
Commons content ID이며 URL을 넣을 수 없습니다. `fetch`는 AbortSignal·manual redirect를
준수해야 합니다. host는 `root`를 다른 세션이 바꿀 수 없는 계정별 전용 폴더로 제한하고,
반환 asset을 영속 등록한 후에만 UI 완료/전사 job을 확정해야 합니다.

범위: 이번 작업은 collector 모듈이며 영상 목록 선택 UI, host IPC, 영속 job 원장과
자동 전사 연결은 WBS-026/027에서 합칩니다. 실제 KHU 영상 계정 접근·실제 강의 재생은
미실행이며 합성 MP4와 HTTP fixture로 검증했습니다. 직접 MP4 원본이 없는 강의는
UNSUPPORTED_FORMAT으로 남으며 전체 MVP 완료로 간주하지 않습니다.

검사: `docker compose run --rm tools` (타입 검사·collector/기존 workspace 회귀).

사용자가 앱에서 수집을 실행하면 host가 호출하는 Mac 내부 LMS 수집 모듈입니다(CR-001, ADR-002). 한 과목의 주차(Canvas module)를 `Course`, `Week`로 정규화하고(WBS-007), 주차에 걸린 파일·공지·과제를 `ManifestItem`으로 정규화하면서 원본 파일을 받아 해시로 검증합니다(WBS-008). 수집 결과는 revision manifest와 SyncRun으로 Mac에 기록합니다(WBS-010). HTTP 전달 서비스는 없습니다(CR-001).

```ts
const client = new CanvasClient({ getAuthHeaders });
const { course, weeks } = await discoverCourse({ client, accountKey, sourceCourseId: "95899" });
```

```ts
const store = createDirectoryStore(dataRoot); // host가 데이터 폴더를 정한다
const result = await collectResources({ client, store, course, weeks, previous }); // previous = 마지막 정상 manifest
// result.items, result.tombstones, result.errors(비어 있지 않으면 partial), result.skippedTypes
```

## 한 번의 수집 실행과 기록 (WBS-010)
```ts
const { syncRun, manifest, written } = await collectCourse({ client, store, root, accountKey, sourceCourseId: "95899" });
const status = await readSyncStatus(root, accountKey); // collection.status: lastSucceeded, current
```
- **저장 위치(host가 정한 `root` 아래):** `courses/<courseId>/current.json`(현재 manifest), `courses/<courseId>/revisions/<n>.json`(모든 revision), `sync-runs/<id>.json`(실행 기록), `originals/…`(원본). courseId에 계정이 들어 있어 계정끼리 섞이지 않습니다.
- **적용 순서:** 새 manifest가 가리키는 원본 파일을 모두 다시 해시해 맞을 때만, revision 파일을 쓰고 `current.json`을 원자적으로 바꿉니다. 하나라도 틀리면 `CHECKSUM_MISMATCH`로 멈추고 이전 정상본이 그대로 남습니다.
- **멱등:** 내용(과목·주차·자료·tombstone)이 같으면 아무것도 쓰지 않고 revision도 그대로입니다. 실행 기록만 남습니다.
- **실행 결과:** 오류가 없으면 `succeeded`, 자료 일부 실패는 `partial`(성공으로 보고하지 않음), 로그인 만료·버전 불일치·기록 손상 등은 `failed`. 실패해도 예외를 던지지 않고 SyncRun으로 남깁니다.
- **읽기 검사:** 다른 계약 major는 `SCHEMA_VERSION_UNSUPPORTED`(앱 업데이트 필요), 다른 계정·과목의 manifest는 `SCOPE_VIOLATION`, 깨진 JSON은 `CHECKSUM_MISMATCH`. 문제 파일은 덮어쓰지 않습니다.
- **화면 연결:** host(WBS-012)가 `collection.run/status`, `library.manifest`에 연결합니다.

## 재시도·중복 실행·중단·변경 표시 (WBS-009)
- **재시도:** 계약에서 재시도 가능으로 표시한 오류(연결 실패, 5xx, 요청 제한, 끊긴 다운로드)만 최대 3번까지 시도합니다(1초, 2초 간격). LMS가 `Retry-After`를 주면 60초 이내일 때만 기다리고, 더 길면 그 시각을 오류에 남기고 넘어갑니다. 로그인 만료는 한 번도 다시 시도하지 않습니다.
- **한 번에 하나:** 계정·과목마다 `locks/*.lock` 파일로 실행을 하나로 제한합니다. 실행 중에 다시 누르면 `RUN_ALREADY_ACTIVE`로 거절하고 아무것도 쓰지 않습니다(이 경우만 예외를 던짐). 앱이 죽어 남은 잠금(프로세스 없음, 6시간 초과)은 다음 실행이 가져갑니다.
- **중단 후:** 실행은 시작할 때 `running`으로 기록됩니다. 다음 실행(또는 host 시작 시 `recoverInterruptedRuns`)이 주인 없는 `running` 기록을 `interrupted`로 바꾸고, 반쯤 받은 `tmp/*.part`를 지웁니다. 자동으로 다시 보내지 않습니다. 다시 실행하면 끝까지 받은 원본은 같은 해시로 재사용되어 중복이 생기지 않습니다.
- **변경 추적:** `collectCourse` 결과의 `changes`에 새 자료, 내용이 바뀐 자료(revision 증가), LMS에서 사라진 자료가 들어 있습니다. 제목만 바뀐 것은 변경이 아닙니다.
- **상태 문구:** `summarizeRun(syncRun, changes)`가 화면용 문구와 톤(ok/warning/error)을 만듭니다. 로그인 필요, 일부 실패 개수, 요청 제한 해제 시각, 중단, 새로/바뀐/사라진 자료 수, 사라진 자료의 원본과 메모는 지우지 않았다는 안내.

## 자료 수집 (WBS-008)
- **주차 연결:** 각 주차 module의 항목을 읽어 File은 파일 자료, Assignment·Quiz는 과제에 주차를 붙입니다. 같은 파일이 여러 주차에 있으면 가장 앞 주차입니다. Page·Discussion·외부 링크는 아직 계약에 종류가 없어 건너뛰고 `skippedTypes`로 개수만 알립니다.
- **공지:** Canvas announcement 전체(`only_announcements=true`)를 과목 공지로 받습니다. 게시 전 공지는 제외하고, 첨부는 asset으로 받습니다. 공지 본문은 계약에 없어 저장하지 않습니다.
- **과제:** 마감은 UTC로 저장합니다. 시간대가 없는 값은 서울 시간으로 해석하고 `assumed_asia_seoul`로 표시합니다. 마감이 없으면 null입니다. 제출 기능은 없고 제출 페이지 링크만 둡니다.
- **원본 파일:** 임시 파일로 받으면서 sha256을 계산하고, LMS가 알려준 크기와 다르면 버립니다. 맞으면 `originals/<aa>/<sha256>.<ext>`로 원자적으로 옮긴 뒤 다시 읽어 해시를 확인합니다. 같은 해시는 원본 하나를 함께 씁니다.
- **다시 수집:** ID는 계정·과목·LMS ID로 정해져 중복이 생기지 않습니다. 원본이 그대로이고(크기·수정 시각) 저장된 파일의 해시가 맞으면 다시 받지 않습니다. 저장된 파일이 손상됐으면 다시 받습니다.
- **revision:** 내용이 바뀔 때만 올라갑니다. 파일은 해시, 공지는 게시 시각과 첨부, 과제는 마감. 제목만 바뀌면 그대로입니다. 과제 설명 변경은 추적하지 않습니다.
- **부분 실패:** 자료 하나가 실패하면 `errors`에 `resourceSourceId`와 함께 남기고, 이전 정상 항목을 그대로 둡니다. 목록 하나(예: 과제 목록)를 못 받으면 그 종류는 삭제로 판단하지 않습니다. 로그인 만료(`AUTH_REQUIRED`)는 전체를 멈춥니다.
- **삭제·숨김:** 목록을 끝까지 받았는데 사라진 자료는 tombstone(`deleted_at_source`), 잠긴 파일은 `hidden_at_source`. 다시 나타나면 tombstone을 지웁니다. 받은 원본 파일은 지우지 않습니다.
- **파일 다운로드 경로:** LMS 주소에서 시작해 파일 저장소(다른 주소)로 이동하면 그 요청에는 쿠키를 보내지 않습니다. LMS 로그인 페이지로 이동하면 로그인 만료입니다. 처음부터 다른 주소인 다운로드 링크는 받지 않습니다.

## 규칙
- **읽기 전용:** 클라이언트는 GET만 보낼 수 있습니다.
- **인증 정보:** 호출 때 host가 `getAuthHeaders`로 넘겨주며 저장하거나 로그로 남기지 않습니다. 리다이렉트를 따라가지 않고, 다른 주소의 페이지 링크도 거부합니다.
- **ID:** 계정·학기·과목으로 만든 고정 UUID라서 다시 수집해도 중복이 생기지 않습니다.
- **기존 코드:** archive 코드와 recorder skill은 참고하지 않고 공개된 Canvas REST API 형식으로 새로 작성했습니다.

## 오류

| 상황 | 코드 | 재시도 |
|---|---|---|
| 401, 로그인으로 리다이렉트 | `AUTH_REQUIRED` | 다시 로그인 후 실행 |
| 429, 제한을 뜻하는 403 | `RATE_LIMITED` | 가능 |
| 5xx, 연결 실패 | `DOWNLOAD_FAILED` | 가능 |
| 응답 형식 변경, 404, 다른 주소 링크 | `SOURCE_CHANGED` | 불가 |

200으로 온 로그인 HTML은 만료와 구분할 수 없어 `SOURCE_CHANGED`로 처리하고 로그인 확인을 안내합니다.

## 미검증 (WBS-008)
- **실제 LMS 자료 수집을 실행하지 않았습니다.** module item, 파일, 공지, 과제 응답 형식과 파일 다운로드 이동(저장소 주소, 쿠키 없이 받기)은 공개된 Canvas 형식을 바탕으로 만든 합성 응답으로만 시험했습니다.
- 학생 권한에서 module에 없는 파일, 숨김 module, 큰 파일(수백 MB)의 동작.

## 미검증 (WBS-007)
- **실제 경희대 LMS로 실행하지 않았습니다.** fixture는 공개된 Canvas 형식을 바탕으로 만든 합성 데이터입니다. 실제 응답, 세션 방식, 만료 동작은 실제 로그인으로 확인해야 합니다.
- 로그인 화면과 인증 정보 저장은 이 패키지 범위가 아닙니다. host 작업에서 만듭니다.

## 실행
`docker compose run --rm tools`

## LearningX 일반 파일·강의계획서 (WBS-090)

LearningX는 PDF 확장자 대신 `content_type: file`로 강의계획서를 표시하기도 합니다.
열린 일반 파일은 Commons 메타데이터의 실제 확장자를 확인한 뒤 기존 지원 문서 형식과
파일 시그니처 검사에 통과한 원본만 수집합니다. 알 수 없는 형식은 해당 자료 오류로 남고
이전 정상본은 보존됩니다. 닫힌 자료·영상은 이 경로로 받지 않습니다.
앱에서 자료 수집을 다시 실행하면 주차 자료·과목 채팅의 입력으로 사용할 수 있으며,
이미 만든 course.md는 다시 만들 때 반영됩니다. 수집이 AI 요약을 자동 실행하지 않습니다.
합성 일반 파일·재수집 재사용·형식 오류·이전본 보존·파일명 부재·닫힌 파일 회귀를 검증했으며,
실제 누락 과목의 재수집과 강의계획서 내용 추출/시간표 생성은 이 수정에서 실행하지 않았습니다.
