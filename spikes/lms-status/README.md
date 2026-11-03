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

## 결과 2: 열람 기록·출석·제출 흐름 (watch)
미실행 — 이문찬이 앱 창에서 자료 열기·강의 재생을 해야 한다. 연습 과제 제출은 다음에 요청.

## 남은 제약
- 잠금 브라우저 필수 퀴즈(`require_lockdown_browser`)는 앱 창에서 응시할 수 없다 → "전용 브라우저 필요"로 표시.
