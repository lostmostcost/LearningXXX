# SPEC-001 · LMS 수집·동기화·자료 모델

Source: https://app.notion.com/p/40bbd7ec20cd81b8bdefc1dfdb9ba2ed?pvs=204
Snapshot: 2026-11-01 · v0.1.0 · Notion is authoritative; refresh after approved changes.

## 목적과 범위
REQ-002. 서버가 한 학기 한 과목의 주차, 강의자료/첨부, 공지, 과제 메타데이터를 자동 수집한다. 파일만 긁어오는 다운로드 도구가 아니라 과목과 주차의 관계, 출처, 변경 이력을 보존하는 학습 데이터 공급원이다.

## 제안 데이터 모델
| 엔터티 | 주요 필드 | 불변 조건 |
| Course | id, termId, sourceCourseId, title | 계정+학기+학교 식별자로 중복 방지 |
| Week | id, courseId, sourceWeekId, label, order | 화면 정렬과 원본 주차 표기 분리 |
| Resource | id, courseId, weekId?, kind, sourceId, sourceUrl, title, revision, updatedAt | 파일·공지·과제를 동일 자료 목록에서 참조 |
| Asset | id, resourceId, mediaType, bytes, sha256, storageKey, originalName | 원본 불변, 동일 해시 재사용 |
| AssignmentMetadata | resourceId, dueAt?, timezone, submissionUrl? | 제출/평가 조작 없음; 불명확한 마감은 null |
| SyncRun | id, scope, cursor, startedAt, status, errors | 일부 실패를 전체 성공으로 표시하지 않음 |
| DeliveryManifest | version, courseId, revision, items, tombstones | 전달 완료 전 기존 로컬 정상본 유지 |

외부 LMS ID와 내부 UUID를 분리한다. 시간은 UTC로 저장하고 Asia/Seoul로 표시한다. 학교가 시간대를 명시하지 않으면 해석 근거를 기록한다. weekId가 없는 공지는 과목 공지로 보인다. UI 제목 변경을 동일 자료의 새로운 리소스로 오인하지 않는다.

## 처리 흐름
1. 예약 작업이 인증 유효성을 검사한다. 만료면 auth_required로 중단하고 재인증 경로를 표시한다.
2. 과목·주차 목록과 각 자료 메타데이터를 수집한다. 페이지 단위 체크포인트와 원본 식별자를 보존한다.
3. 첨부 원본을 임시 파일로 받으며 크기·형식·해시를 검증한다. 완료 시 원자적으로 확정한다.
4. 새 revision manifest를 발행한다. Mac은 인증된 요청으로 바뀐 항목만 가져온다.
5. Mac이 해시를 검증한 후 로컬 인덱스를 트랜잭션으로 갱신한다. 다운로드 중 끊기면 정상본을 유지한다.
6. 삭제/숨김 원본은 tombstone으로 기록한다. 사용자의 로컬 노트와 결과물은 자동 삭제하지 않는다.

## 동기화 계약 초안
GET /v1/courses, GET /v1/courses/{id}/manifest?after={revision}, GET /v1/assets/{id}, GET /v1/sync-runs/{id}. 스케줄 주기와 호스팅/인증은 ADR-003에서 결정한다. 새 manifest는 schemaVersion을 포함하며 알 수 없는 버전은 명시적으로 업데이트 필요 상태가 된다. 같은 revision 재전달은 멱등이다.
오류 코드: AUTH_REQUIRED, SOURCE_CHANGED, RATE_LIMITED, DOWNLOAD_FAILED, CHECKSUM_MISMATCH, UNSUPPORTED_FORMAT. 재시도 가능 여부와 다음 시도 시각을 구분한다. 무한 로그인 재시도하지 않는다.

## 사용자 경험
마지막 성공 시각, 진행 중, 일부 실패, 재인증 필요를 구분한다. 오프라인에서는 이미 받은 자료를 읽는다. 과목과 주차 필터, 공지/과제 표시, 원문 열기를 제공한다. 수동 업로드는 manual source로 구분하며 서버 수집본과 출처를 혼동하지 않는다.

## 구현 경계
collector는 수집/정규화에만, sync 서비스는 전달/버전 관리에만, Mac sync 모듈은 검증/로컬 저장에만 책임을 가진다. 학교 HTML 파서 변경이 UI까지 전파되지 않도록 정규화 계약을 먼저 만든다. 학교 계정별 자료는 분리 저장한다. LMS 자격증명을 Git/Notion/로그/AI 프롬프트에 넣지 않는다.
기존 khu-ecampus-archive 코드 자체·helper·실행파일은 재사용하지 않는다. 실제 사이트의 읽기 경로·구조를 확인하여 독립 구현한다. 기존 recorder 자료를 수집 구현의 우회 참고자료로 쓰지 않는다.

## 수용 시나리오
- 동일 자료를 2회 수집해 중복이 생기지 않고, 변경 자료만 revision이 증가한다.
- 공지/첨부/과제 마감이 주차와 연결되고 원문으로 이동한다.
- 로그인 만료, 자료 하나 실패, 네트워크 중단에서 정상 자료는 보존되고 실패 원인이 드러난다.
- 두 계정 fixture에서 다른 계정 자료가 전달되지 않는다.
- 시험용 원본 변경·삭제에도 로컬 사용자 메모와 기존 정상 파일이 예기치 않게 사라지지 않는다.

