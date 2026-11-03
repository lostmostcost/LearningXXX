# WBS-054 · LMS 학습 상태·제출 흐름 실측

CR-054(docs/plans/PLAN-054-learning-status.md). 2026-11-03, 이문찬 계정, 수강 6과목, 읽기 전용.

## 방법
- `--lms-status-probe=<파일>`: 저장된 로그인 정보로 한 번 로그인(수집과 같은 경로) 후 GET만. 응답의 **필드 경로·타입·상태성 값**만 기록하고 제목·이름·본문·URL·토큰은 남기지 않는다(`apps/desktop/host/src/lms-status-probe.ts`).
- `--lms-watch=<파일>`: 앱 창에서 사용자가 LMS를 쓰는 동안 요청의 방법·호스트·경로(긴 번호 가림)와 쓰기 요청의 본문 **필드 이름**만 기록.

## 결과 1: 상태 읽기 (status-probe)

항목 수: 동영상 33, PDF 94, Zoom 69, 파일 7, 과제 40, 퀴즈 1(LearningX 모듈 기준).

LearningX 모듈 항목(`/learningx/api/v1/courses/:id/modules?include_detail=true`)에 LMS 화면의 배지가 그대로 있다:

| 필드 | 값 | 뜻 |
|---|---|---|
| `completed` | true/false | "완료" 배지 |
| `completion_determinable` | true/false | 완료를 판정할 수 있는 항목인지 |
| `attendance_status` | attendance / none / absent | "출석" 배지(출석/미출석/결석) |
| `content_data.use_attendance` | bool | 출석 반영 항목 |
| `content_data.opened`, `lecture_period_status` | bool, open / not_open / late_after | 공개 여부, 수강 기간(지각 기간 포함) |
| `content_data.unlock_at`·`due_at`·`lock_at`·`late_at` | 날짜 | 시작·마감·종료 |
| `content_data.item_content_data.duration`, `progress_support` | 초, bool | 영상 길이, 진도 추적 여부 |
| 항목 상세 `attendance_items/:id` → `attendance_data.progress`·`completed`·`attendance_status`·`last_at` | 초 등 | 실제 시청 진도(초) |

Canvas 과제(`/api/v1/courses/:id/assignments?include[]=submission`):
`submission.workflow_state`(unsubmitted / submitted / pending_review / graded), `submitted_at`, `late`, `missing`, `seconds_late`, `attempt`, `score`, `submission_types`(online_upload / online_quiz / online_url / on_paper / none), `allowed_extensions`, `allowed_attempts`(-1=무제한), `due_at`·`lock_at`·`unlock_at`, `lock_info`.

Canvas 퀴즈(`/api/v1/courses/:id/quizzes`): `due_at`·`lock_at`·`unlock_at`, `allowed_attempts`, `question_count`, `permissions.submit`, **`require_lockdown_browser`(일부 true)**. 한 과목은 퀴즈 목록 요청이 거부됨(퀴즈 탭 비활성으로 추정) → 실패 시 "없음"으로 처리.

판단: **상태 읽기(WBS-055)는 바로 구현 가능.** 완료·출석·진도·마감·제출 상태 모두 읽기 전용 GET으로 얻는다.

## 결과 2: 열람 기록·출석 흐름 (watch, 2026-11-03 이문찬 조작, 316건)

이문찬이 앱 창에서 로그인 → 미완료 PDF 열기 → 미시청 강의 약 3분 30초 재생 → 닫기. 기록은 방법·경로(번호 가림)·쓰기 본문 필드 이름뿐.

흐름(항목 하나를 열 때 공통):
1. `GET /courses/:cid/modules/items/:itemId` (주차학습 항목 페이지)
2. `POST /learningx/lti/lecture_attendance/items/view/:id` — Canvas가 서명한 LTI 실행(oauth_* 필드). LearningX 뷰어 프레임이 열림
3. `GET /learningx/api/v1/courses/:cid/attendance_items/:id` — 항목 상태
4. Commons 뷰어 `GET commons.khu.ac.kr/em/<id>?startat&endat&…&pr&mxpr`

**PDF 열람 기록**: 문서 뷰어가 열리자마자
- `POST /learningx/api/v1/courses/:cid/sections/0/components/:id/progress/forceSubmit?user_id&user_login&content_id&content_type`
- 이어서 `GET …/progress?…&state&duration&currentTime&cumulativeTime&page&totalpage…`(JSONP, `callback`)
→ PDF는 **뷰어를 여는 것만으로 완료**가 기록된다.

**동영상 출석**: 재생 중 약 2분마다 Commons 플레이어가 `GET …/components/:id/progress?…&state&duration&currentTime&cumulativeTime…`(JSONP)로 **누적 시청 시간**을 보고한다. 별도 쓰기 API 없이 이 보고가 쌓여 `attendance_data.progress`가 되고, 영상 길이 대비 기준을 넘으면 출석이 된다. 페이지도 주기적으로 `attendance_items/:id`를 다시 읽는다.

판단:
- **열람 기록(WBS-056)**: 앱 뷰어에서 사용자가 PDF를 열면 LMS의 공식 항목 페이지를 보이지 않는 창(같은 로그인 세션)으로 열어 **LMS 뷰어가 스스로 forceSubmit**하게 한다. 요청을 직접 위조하지 않으므로 LMS가 바뀌어도 공식 흐름을 따른다. `forceSubmit` 응답을 확인하면 창을 닫고 상태를 다시 읽는다.
- **출석(WBS-057)**: 진도 보고는 플레이어의 누적 시청 시간 보고이므로, 이를 앱이 직접 보내는 것은 시청 없는 출석 위조다(CR-054에서 제외). **앱 안 보이는 창에서 공식 플레이어로 실제 재생·시청**하고, 앱은 `attendance_items`로 진도·출석을 추적·표시한다.
- **제출**: 이번 기록에 없음. 연습 과제로 다음에 실측(Canvas 표준 파일 제출 예상).

## 남은 제약
- 잠금 브라우저 필수 퀴즈(`require_lockdown_browser`)는 앱 창에서 응시할 수 없다 → "전용 브라우저 필요"로 표시.
