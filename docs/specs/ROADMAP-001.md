# ROADMAP-001 · 의존성 기반 로드맵과 병렬 작업

Source: https://app.notion.com/p/40bbd7ec20cd81ae94a9c0516b9256a5?pvs=204
Snapshot: 2026-11-01 · v0.1.0 · Notion is authoritative; refresh after approved changes.

## 일정 기준
달력 일정·담당자·공수는 아직 확정하지 않았다. 지금은 의존성 DAG와 작업별 수용 조건을 기준으로 진행한다. G0 결과와 두 사람의 주간 투입 가능 시간을 확인한 뒤 예상작업일·시작·종료를 채운다. 2인이므로 작업일 합계의 절반을 자동 프로젝트 기간으로 계산하지 않는다.

## 단계별 병렬화
| 단계 | 병렬 가능한 묶음 | 통합 조건 |
| G0 | CLI 기술검증 / 실제 과목·파일·QA 기준 결정 | 구독·세션 격리 및 필수 결정 |
| G1 | 환경 재현 / 계약·fixture 정의 | 계약 merge 후 하위 작업 Ready |
| A-1 | 서버 collector / Mac shell·viewer | 정규화 fixture 일치 |
| A-2 | server sync / local CLI adapter·session | 계약 변경은 shared 먼저 |
| A-3 | local sync / chat composer | host IPC 변경은 host 영역 조율 |
| A-4 | 선택 번역 / 통합·복구 테스트 준비 | A 사용자 QA |
| B-1 | 대면 녹음 / 온라인 다운로드 | media 계약 확정 |
| B-2 | STT worker / 전사 뷰어 | job·timestamp 계약 일치 |
| B-3 | 통합 복구 / 실사용 검수 준비 | 전체 MVP gate |

동시 진행할 작업은 '담당 역할'이 아니라 '잠긴 영역이 겹치지 않는 Ready 작업'으로 고른다. 그래프의 선행 미완료는 Backlog다. 문서·계약·root lockfile은 shared 영역으로 직렬 처리한다.

## 진행 현황 읽는 법
WBS 상태 보드에서 Review/Human QA 정체를 먼저 확인한다. Ready 미배정 뷰에서 다음 일을 고르고 Blocked 원인과 후속 영향을 확인한다. 단계 로드맵은 순서와 의존관계를 보여주며 날짜 확정 후 타임라인을 사용한다.
완료율을 보고할 때는 Done/전체와 A/B gate 상태를 함께 쓴다. 작업 수 완료율은 기능 가치나 출시 가능성과 같지 않다. 기능 완료 근거는 연결 QA와 병합 PR이다.

## 재계획
실험 실패, 계약 변경, 사용자 QA 피드백은 CR/백로그로 기록한다. 영향을 받는 후속 작업을 Ready에서 Backlog/Blocked로 되돌리고 이유를 적는다. 분해가 너무 크면 기존 ID를 삭제하지 말고 parent 설명과 새 하위 WBS를 연결한다. 새로운 MVP 범위는 두 사람이 합의하기 전 본 기준을 대체하지 않는다.

