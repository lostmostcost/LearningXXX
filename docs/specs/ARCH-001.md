# ARCH-001 · 아키텍처·계약·개발 환경

Source: https://app.notion.com/p/40bbd7ec20cd815bb87ad1ce5b9e1d04?pvs=204
Snapshot: 2026-11-01 · v0.1.0 · Notion is authoritative; refresh after approved changes.

## 제안 아키텍처
이 문서는 설계 제안이다. 기술 선택은 ADR-002를 따르고, 서버는 없다(CR-001). 초기 저장소는 특정 UI 프레임워크를 강제로 설치하지 않는 공통 검증 환경과 구조를 제공한다.

| 경계 | 책임 | 배치 |
| --- | --- | --- |
| Desktop renderer | 자료 뷰어·채팅·세션·녹음 상태 | Mac 앱 UI |
| Desktop host | 공식 CLI 프로세스·파일 접근·키체인/마이크·IPC | 각자의 Mac |
| CLI adapter | 실행·이벤트·재개·오류 정규화 | host 내부 |
| Collector | LMS 인증·파싱·정규화 | Mac host 내부 |
| STT worker | 원본→전사 job | 엔진 선정 후 Mac 또는 컨테이너 |
| Contracts | DTO·스키마·오류·버전 fixture | 공통 패키지 |

renderer는 임의 shell 명령을 실행하지 못한다. host에 타입이 있는 요청을 보내고 host가 scope를 확인한다. 수집과 AI 세션 장애를 독립적으로 복구한다.

## 저장소 경로와 병렬 경계
apps/desktop/ui, apps/desktop/host, packages/cli-adapter, packages/collector, services/transcriber, packages/contracts, tests/fixtures, tests/acceptance, infra, docs.
공유 계약·루트 의존성·마이그레이션·CI는 shared 영역으로 직렬화한다. 서로 다른 디렉터리만 수정해도 계약을 바꾸면 충돌하므로 관련 작업을 잠시 멈추고 계약 PR을 먼저 병합한다. 시작할 때 WBS의 경로/잠금 영역을 확인한다.

## 계약 초안
CLI: startRun({sessionId?,mode,workspace,inputs,requestId}) → AsyncEvents. resume는 app session과 CLI session을 명시적으로 매핑한다.
Event envelope: schemaVersion, eventId, runId, occurredAt, type, payload. 타입은 run.started, text.delta, tool.requested, artifact.created, run.completed, run.failed, run.cancelled.
파일/수집: resource manifest와 asset hash를 버전 관리한다. metadata-only 변경과 binary 변경을 분리한다. 모델의 자유 텍스트를 앱의 명령으로 실행하지 않는다.
계약 fixture는 실명·학번·쿠키·강의 비공개 내용이 없는 합성 데이터로 만든다.

## 데이터 보존·이동
수집 원본 폴더와 앱 캐시는 분리한다. 파일명만으로 키를 만들지 않는다. 다운로드는 임시→검증→원자 이동, 메타데이터는 트랜잭션으로 처리한다. 사용자 작성 파일은 원본 자료와 디렉터리를 나눈다. 버전 마이그레이션은 백업·실패 복구를 포함하며 두 개발자가 별도 마이그레이션을 동시에 만들지 않는다.

## Docker 공통 환경
Docker Desktop의 컨테이너는 Linux VM에서 실행된다. 따라서 공통 서비스·합성 데이터·계약 검사·CI를 컨테이너로 고정하고 macOS GUI·마이크·키체인·구독 CLI 검증은 호스트에서 수행한다. [Docker 공식 설명](https://docs.docker.com/desktop/features/vmm/).
compose.yaml은 공통 tools 서비스부터 제공한다. 서비스 런타임은 ADR 후 정확한 이미지 버전/digest와 lockfile을 고정한다. 두 사람의 Mac CPU 차이도 기록하고 linux/arm64와 amd64 차이를 필요한 범위에서 검증한다. 'Docker를 썼으므로 모든 Mac 동작이 동일'하다고 주장하지 않는다.
호스트의 ~/.claude, 키체인, LMS 쿠키, 홈 전체를 컨테이너에 마운트하지 않는다. 실행 데이터는 gitignore 대상이며 fixture만 버전 관리한다.

## 품질과 관측
requestId/runId/syncRunId로 흐름을 추적한다. 기본 로그에는 프롬프트 원문·구독 인증·학교 쿠키·음성 원본을 넣지 않는다. 오류 유형·소요시간·재시도 횟수를 기록한다. 사용자 지원용 진단 export는 미리보기와 민감값 제거를 거친다.
CI는 공통 검사와 변경 영역 테스트를 수행한다. macOS 기능은 실제 두 Mac의 체크리스트로 검증한다. CI 통과를 인간 QA 완료로 대체하지 않는다.

## 주요 위험과 대응
구독 CLI/독립성 실패 → G0에서 진행 판단. LMS HTML 변경 → adapter fixture와 실패 탐지. 계약 동시 변경 → shared lock+선행 PR. 녹음 유실 → 청크 보존+복구 검수. 문서의 거짓 최신 상태 → CR/버전/증거 갱신. 일정 과소평가 → G0 이후 실제 throughput 기반 재추정.

