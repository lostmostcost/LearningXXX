# Desktop app (WBS-011)

Electron + React 골격입니다(ADR-002). `host/`는 main process이고 `ui/`는 renderer입니다.

- **경계:** renderer는 샌드박스에서 실행되고 Node에 접근할 수 없습니다. `window.host.invoke`로 계약에 있는 채널만 호출하며, host가 모든 요청을 `@learningxxx/contracts`로 다시 검증합니다.
- **현재 기능:** 빈 상태 화면, 수집 상태 조회, F6 패널 이동, 900px 미만 자료/채팅 전환. 수집, 뷰어, 채팅 연결은 후속 WBS입니다.

## Mac에서 실행
고정 버전(Node 24.22.2, pnpm 12.14.0)이 필요합니다. 의존성 설치 스크립트는 실행하지 않으므로 Electron 실행 파일을 직접 받습니다.

```sh
pnpm install
node apps/desktop/host/node_modules/electron/install.js
pnpm --filter @learningxxx/desktop-ui build
pnpm --filter @learningxxx/desktop-host start
```

## 검사
`docker compose run --rm tools`

## 실제 LMS 확인 (WBS-034)
LMS 계정 주인이 **자기 Mac에서 직접** 로그인합니다. 계정을 다른 사람의 Mac에 입력하지 않습니다.

```sh
git fetch origin && git switch feat/WBS-034-lms-login
pnpm install
node apps/desktop/host/node_modules/electron/install.js
pnpm --filter @learningxxx/desktop-ui build
pnpm --filter @learningxxx/desktop-host build
apps/desktop/host/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop/host --lms-probe=/tmp/lms-probe.json
```

1. "학교 로그인" 창에서 로그인합니다. 창이 뒤에 있으면 Dock의 Electron 아이콘을 누릅니다.
2. 수집에 성공하면 창이 닫히고 앱이 종료됩니다. 닫히지 않으면 강의 화면까지 들어간 뒤 창을 직접 닫습니다.
3. `/tmp/lms-probe.json`을 열어 내용을 확인한 뒤 공유합니다.

대기 시간은 10분이고, 읽기 요청만 보냅니다. 결과에는 과목명, 학기 번호, 주차 이름, 응답 필드 이름과 오류 코드만 들어갑니다. 쿠키와 비밀번호는 없습니다. 로그인 상태는 이 Mac의 앱 전용 저장소에 남습니다.
