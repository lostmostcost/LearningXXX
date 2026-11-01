# LearningXXX

경희대 학생의 개인용 macOS 학습 공간. 이문찬(lostmostcost)·안상현(Kishibae)이 공동 개발합니다.

**현재 상태: 기획·협업 scaffold. 제품 기능은 아직 구현하지 않았습니다.**
A: 서버 LMS 수집 → Mac 자료·자유 채팅·세션·선택 번역.
B: 녹음·온라인 영상 원본 → 자동 전사. 전체 MVP는 A+B입니다.
각자 공식 Claude Code 구독 로그인을 사용하며 API 인증으로 대체하지 않습니다.

## 시작

1. [PM 허브](https://app.notion.com/p/40bbd7ec20cd802d9a66d29b84978eb4)와 [AGENTS.md](AGENTS.md)를 읽습니다.
2. Docker Desktop을 실행하고 아래 공통 검사를 실행합니다.
3. Notion의 Ready 미배정 작업을 우선순위대로 고르고 task/area claim을 획득합니다.
4. 자기 브랜치에서 구현 → 자체 검토·CI 통과 → 각자 PR 병합. 기능 구조 설명과 실제 사용자 QA를 마친 뒤 WBS Done.

```sh
git clone https://github.com/lostmostcost/LearningXXX.git
cd LearningXXX
docker compose run --rm tools
```

호스트에서 도구 검사만 실행하려면 Python 3.12+와 Git이 필요합니다.

```sh
python3 scripts/check.py
python3 -m unittest discover -s tests/tooling -v
```

Python은 현재 저장소 운영 도구의 런타임입니다. 앱 UI/서버 기술 스택은 G0 ADR에서 결정합니다.
컨테이너는 공통 검사·서비스 개발용입니다. macOS GUI·마이크·키체인·개인 구독 CLI는 Mac host에서 검증합니다.

## 문서

- [기획/요구사항 스냅샷](docs/specs/PRD-001.md)
- [협업 규칙](docs/specs/OPS-001.md)
- [개발 환경과 선점](docs/DEVELOPMENT.md)
- [기능 설명·QA 양식](docs/templates/feature-qa.md)
- [AI 입력 양식](docs/templates/agent-task.md)
- [WBS 기계 판독 데이터](docs/pm/wbs.json)
- [Notion 문서/DB 주소](docs/pm/notion-map.json)

Notion은 기획·상태·QA 원본, GitHub는 코드·계약·검증 원본입니다. docs/specs는 날짜/버전이 있는 스냅샷이며 자동 양방향 동기화는 없습니다.

## 구현 경계

```text
apps/desktop/ui/      # 자료·채팅 화면
apps/desktop/host/    # Mac 권한·IPC·로컬 데이터
packages/cli-adapter/ # 공식 CLI 실행/세션
packages/contracts/  # 공동 데이터 계약 (shared lock)
services/collector/  # LMS 신규 구현
services/sync/       # Mac 자료 전달
services/transcriber/# 엔진 결정 후 자동 전사
tests/fixtures/      # 비공개 자료 없는 합성 fixture
tests/acceptance/    # 통합 시나리오
```

기존 archive 코드를 복사하거나 실행하여 재사용하지 않습니다. recorder skill은 구현 단계에서 열람·참고·복사·포팅하지 않습니다.
강의 원본, 쿠키, 계정 정보, Claude 인증 정보는 Git에 넣지 않습니다.

