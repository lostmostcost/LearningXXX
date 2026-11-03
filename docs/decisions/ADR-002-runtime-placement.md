# ADR-002 · UI·서버 런타임과 배치 (WBS-004)

- 상태: 제안. 결정 3은 안상현 결정이다. 결정 1의 Electron은 WBS-011에서 앱 프로세스 실행을 확인했다.
- 요구: REQ-001, REQ-010, 연관 REQ-003, REQ-005, REQ-007, REQ-011
- 근거: WBS-001, WBS-002, WBS-003 결과, ARCH-001, SPEC-001~005
- 가정: 아래 "미검증" 항목은 시험한 사실이 아니라 구현 전 확인할 항목이다.

## 판단 기준

1. 48~72시간 목표 안에서 두 사람이 병렬로 만들 수 있는가
2. 공식 CLI 프로세스를 앱이 직접 실행하고 stream을 읽을 수 있는가
3. PDF 뷰어, 화면 캡처, 마이크 녹음을 지원하는가
4. 앱 안에서 코드 수정 후 재빌드할 수 있는가 (REQ-011)
5. renderer가 임의 명령을 실행하지 못하게 분리할 수 있는가

## 결정 1. Mac 앱: Electron + TypeScript + React

| 후보 | 장점 | 단점 | 판단 |
|---|---|---|---|
| Electron | PDF.js, 웹 UI, Node `child_process`, 소스 재빌드가 쉬움 | 앱 크기, 메모리 | **채택** |
| Tauri | 가볍다 | Rust 필요, 현재 Mac에 Rust 없음, host 코드 진입 장벽 | 기각 |
| SwiftUI | 네이티브 권한, 메모리 | PDF 외 UI 개발 속도, REQ-011에 Xcode 빌드 필요, 공용 코드 없음 | 기각 |

기각 이유의 핵심은 일정과 REQ-011이다. 8GB Mac의 메모리 부담은 수용한다.

- main process가 host 역할을 맡는다. CLI 실행, 파일, 키체인, IPC를 담당한다.
- renderer는 `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`로 실행한다.
- preload는 타입이 있는 요청만 노출하고, host가 경로와 scope를 다시 검증한다.

## 결정 2. 언어와 저장소: TypeScript 단일 + pnpm workspace

renderer와 host가 `packages/contracts`를 그대로 공유한다. Python은 저장소 운영 도구로만 유지한다. Node LTS와 lockfile은 WBS-005에서 고정한다.

## 결정 3. 수집과 저장: 각자의 Mac에서 로컬 실행

안상현 결정(2026-11-01). 서버, VPS, 사설망을 두지 않는다. 월 비용은 없다.

- 두 사람이 각자의 Mac에서 수집한다. 자료와 LMS 인증 정보는 그 Mac 밖으로 나가지 않는다.
- collector는 Mac 앱의 host 안에서 실행하고, 저장은 SQLite와 로컬 파일을 쓴다.
- 수집은 사용자가 앱에서 직접 실행할 때만 동작한다. 자동·예약 수집은 일단 MVP에서 제외한다(안상현 결정, 2026-11-01).
- 수집 코드는 호출 한 번으로 실행되게 만들어, 나중에 자동 수집을 붙일 수 있게 한다.
- 원본 자료와 앱 캐시를 나누던 서버/Mac 구분은 로컬 폴더 구분으로 대체한다.

| 후보 | 장점 | 단점 | 판단 |
|---|---|---|---|
| 각자 Mac 로컬 실행 | 비용 없음, 인증이 외부로 나가지 않음, 전달 계층 불필요 | 꺼져 있으면 수집 안 됨, 두 Mac이 각각 수집 | **채택** |
| 한 Mac에서 서버 실행 | 수집 1회로 공유 | 그 Mac 의존, 사설망과 전달 계층 필요 | 기각 |
| VPS | 항상 켜짐 | 월 비용, LMS 인증이 외부 서버에 놓임 | 기각 |

## 결정 4. 기획 변경 필요 (CR)

기존 요구는 "서버 자동 수집"이다. 이 ADR은 범위를 바꾸므로 CR을 먼저 기록해야 한다.

- REQ-002, PRD-001: 서버 자동 수집을 Mac 로컬 수동 수집으로 변경
- SPEC-001, ARCH-001: 서버, 호스팅, HTTP manifest API 제거
- WBS-007, 008, 024: 경로를 `services/collector/`에서 Mac 내부 모듈로 변경
- WBS-009: 예약 수집을 빼고, 수동 실행의 재시도와 변경 추적만 남긴다
- WBS-010: 서버 전달 서비스가 불필요하므로 취소 후보
- WBS-012, 019, 027: 서버→Mac 수신 흐름을 로컬 저장 흐름으로 변경
- 원칙 변경: 수집이 "자동"에서 "수동"으로 바뀐다. WBS-003의 자동 수집 원칙과 AGENTS.md의 "Automatic collection" 문구도 수정 대상이다

## 결정 5. 독립 세션 경계: CLI 강제 수준 수용

권고: 수용한다. 위협 모델이 공격자가 아니라 자동 문맥 유입이기 때문이다. WBS-002는 이 위협을 두 Mac에서 차단했다.

조건:

- `ISOLATION.md`의 플래그를 host 코드로 고정한다.
- 실행 후 `tools`, `mcp_servers`, `apiKeySource`를 검사해 다르면 세션을 중단한다.
- CLI 버전이 바뀌면 `isolation.py`를 다시 실행한다.
- OS 수준 격리는 MVP 밖이다. 공격자 대응이 요구되면 CR로 다시 연다.

## 범위 밖

STT 엔진과 실행 위치는 WBS-021에서 정한다. 자동 수집은 MVP 이후 필요할 때 CR로 다시 연다.

## 미검증 (구현 전 확인)

- Finder로 실행한 앱은 셸 PATH를 받지 못할 수 있으므로 `claude`는 절대 경로로 찾는다. WBS-014에서 구현한다.
- 구독 CLI는 Electron 44.9.0 main process에서 일반 호출과 격리 플래그 호출 모두 `apiKeySource: none`으로 동작했다(WBS-011, `open` 실행). 다만 그 프로세스의 PATH에 Homebrew 경로가 있어, Finder 더블클릭과 완전히 같은 환경인지는 확인되지 않았다. 패키징된 앱에서도 다시 확인한다.
- 서명하지 않은 로컬 빌드에서 마이크, 화면 캡처 권한이 유지되는지 확인되지 않았다.
- LMS 로그인 방식과 세션 수명을 모른다. 수동 재로그인이 얼마나 자주 필요한지 확인되지 않았다.
- REQ-011의 재빌드, 재시작 경로는 Electron에서 시험하지 않았다.

## 되돌릴 조건

앱 프로세스에서 구독 CLI 실행이 실패하면 Electron 선택을 포함해 이 ADR을 다시 연다.

## 결정 6 · CR-050: 공식 대화형 Claude Code 중심
사용자 직접 승인으로 새 대화는 node-pty(host) + xterm.js(renderer)로 공식 interactive CLI에 연결한다. 구독 인증은 기존 CLI preflight가 확인하며 API 키 대체·인증 추출은 없다. 새 일반 대화는 과거 independent 격리를 제공하지 않는다고 명시한다. 결정5는 legacy structured 경로에만 적용한다.
PTY native addon은 Mac/Electron에서 실제 실행 검증한다. pnpm 자동 build script는 node-pty도 false로 유지한다. 공식 패키지에 동봉된 Mac spawn-helper의 실행 권한 준비만 명시 setup:pty에서 수행하며 임의 native addon을 다운로드하지 않는다. Python PTY 코드는 검증용 spike이며 제품 런타임 의존성이 아니다.


## 결정 7 · CR-051: 공식 SDK 위의 채팅 기본 화면
사용자 직접 승인으로 기본 채팅은 공식 Agent SDK의 구조화 스트림·제어 API를 사용하며 설치된 공식 CLI 실행 파일을 지정한다. 인증은 Mac의 기존 구독 로그인 preflight이며 API fallback은 없다. SDK는 최소 배포 경과 정책을 지킨 0.3.301로 고정하고 CLI 2.1.317과 합성 실검증했다. 모델·강도·모드·문맥·MCP·권한·파일 체크포인트는 엔진이 책임지고 UI가 실제 값만 표시한다. 구독 사용량 API는 실험 상태이므로 별도 호환 어댑터와 명시 실패 안내를 둔다.
PTY/xterm은 고급 도구에 유지하며 동일 세션의 SDK와 PTY 실행은 상호 배타적이다. 양쪽 전환은 SessionStart 매핑으로 재개하고 현재 CLI 원본 메시지를 읽어 표시한다. Markdown은 기존 안전 렌더러를 재사용하며 renderer가 실행 경로·인증·임의 명령 인자를 고르지 못한다. 일반 설정·기억·스킬 허용과 격리 보장 없음은 결정6과 동일하다. 과거 기록 마이그레이션은 생략한다.
