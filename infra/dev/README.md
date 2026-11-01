# 공통 개발 환경 (WBS-005)

- 요구: REQ-010 · 기준: OPS-001 v0.2.0, ADR-002(제안)
- 버전 고정의 원본: [`toolchain.json`](toolchain.json). Dockerfile과 `scripts/host_check.py`가 이 값을 쓰고, `tests/tooling/test_toolchain.py`가 일치를 검사한다.

## 두 층의 환경

| 층 | 무엇을 검사하나 | 명령 |
|---|---|---|
| 공통 컨테이너 | WBS 그래프, 선점 도구, 버전 고정, (계약이 생기면) TypeScript 검사 | `docker compose run --rm tools` |
| Mac host | macOS·CPU, Git 신원·원격, Docker, Node·pnpm, 공식 CLI 절대 경로·버전·구독 로그인, 금지 환경변수 | `python3 scripts/host_check.py` |

컨테이너는 Python 3.13.9 + Node 24.22.2(LTS Krypton) + pnpm 12.14.0이다. 기반 이미지 두 개는 모두 multi-platform digest로 고정한다. pnpm은 빌드할 때 이미지 안에 설치되므로, 실행할 때는 네트워크가 없고 소스가 읽기 전용으로 마운트되어도 동작한다. apt 패키지(git, ca-certificates)는 Debian 저장소에서 받으므로 비트 단위로 재현되는 빌드는 아니다.

Electron 앱은 host에서 실행되므로 **Mac host에도 같은 Node·pnpm이 필요하다**. 설치 방법(버전 관리자 종류)은 각자 정하되, host check가 PASS인지 확인한다. pnpm은 `corepack enable pnpm` 후 `corepack install --global pnpm@12.14.0`으로 맞출 수 있다.

## host check 결과 읽기

- `FAIL`: 앱 개발 전에 고쳐야 한다. 종료 코드 1.
- `WARN`: 같은 major 버전이지만 고정값과 다르거나, CLI 버전이 격리 검증 버전(2.1.316)과 다르다. CLI 버전이 다르면 `spikes/cli/isolation.py`를 다시 실행한다(ADR-002 결정 5).
- `MANUAL`: 마이크, 화면 캡처, 키체인, Finder 실행 앱의 CLI 로그인. 실제 앱이 있어야 확인할 수 있어 WBS-007/011/014/016/023에서 확인한다. 이 스크립트는 PASS로 표시하지 않는다.

`--json PATH`로 증거 파일을 남긴다. auth 결과는 `loggedIn`, `authMethod`, `apiProvider`, `subscriptionType`만 기록하고, 이메일·조직명과 환경변수 값은 남기지 않는다. 모델 요청을 보내지 않으므로 구독 사용량을 쓰지 않는다.

## 선점 재현

`tests/tooling/test_claim.py`가 bare remote와 clone 두 개로 다음을 실제 Git push로 재현한다.

- 같은 작업 동시 선점: 하나만 성공
- 겹치는 영역: 거절되고 일부 ref도 남지 않음
- 소유자가 아닌 clone: receipt가 없으면 해제 불가, SHA를 추측해 위조한 receipt는 lease에서 거절
- 오래된 receipt로 새 소유자의 claim 삭제 불가

CI(`.github/workflows/checks.yml`)는 PR과 main push마다 같은 컨테이너 검사를 실행한다.

## 개발자별 기록

| 개발자 | 일자 | Mac | 컨테이너 검사 | host check | 로컬 이미지 ID |
|---|---|---|---|---|---|
| 이문찬 | 2026-11-01 | macOS 26.6.2 arm64 | 14 tests OK | FAIL 2 (node, pnpm 미설치) · CLI 2.1.316, claude.ai Pro 로그인 PASS | `sha256:864a6e4c4501…` |
| 안상현 | 미실행 | | | | |

로컬 이미지 ID는 빌드 시점의 apt 패키지에 따라 달라질 수 있어 개발자마다 기록만 한다. 두 사람의 값이 같아야 통과하는 조건은 아니다. 상대 개발자의 실행은 필수 QA가 아니다(QA-001). 각자 처음 환경을 맞출 때 자기 행을 채운다.
