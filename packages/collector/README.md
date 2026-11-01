# @learningxxx/collector (WBS-007, WBS-008)

사용자가 앱에서 수집을 실행하면 host가 호출하는 Mac 내부 LMS 수집 모듈입니다(CR-001, ADR-002). 한 과목의 주차(Canvas module)를 `Course`, `Week`로 정규화하고(WBS-007), 주차에 걸린 파일·공지·과제를 `ManifestItem`으로 정규화하면서 원본 파일을 받아 해시로 검증합니다(WBS-008). manifest를 로컬에 기록하는 일은 WBS-010입니다.

```ts
const client = new CanvasClient({ getAuthHeaders });
const { course, weeks } = await discoverCourse({ client, accountKey, sourceCourseId: "95899" });
```

```ts
const store = createDirectoryStore(dataRoot); // host가 데이터 폴더를 정한다
const result = await collectResources({ client, store, course, weeks, previous }); // previous = 마지막 정상 manifest
// result.items, result.tombstones, result.errors(비어 있지 않으면 partial), result.skippedTypes
```

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
