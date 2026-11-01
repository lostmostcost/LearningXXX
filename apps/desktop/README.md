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
