# YOLO UNIV 로컬 개발 앱 · WBS-094

CR-093 / PRD-001 v0.6.0 / REQ-003. 창 제목, 상단 로고, macOS 앱 메뉴·About·Dock 아이콘과 채팅 내보내기 파일 이름을 YOLO UNIV로 표시합니다. 아이콘/로고 원본과 프롬프트는 assets/branding에 있습니다.

내부 package name, userData/sessionData 경로, 로컬 데이터 키, 쿠키 partition과 Claude 세션 경로는 그대로입니다. Electron 44.9.0은 내부 앱 이름을 macOS Safe Storage 서비스명에 사용하므로 `app.setName`이나 package `productName`을 단순 변경하지 않습니다.
근거: https://github.com/electron/electron/blob/v44.9.0/shell/browser/electron_browser_main_parts.cc#L597-L639

## 실행

고정 Node/pnpm으로 `pnpm install --frozen-lockfile` 후 UI와 host를 빌드합니다.

```sh
pnpm --filter @learningxxx/desktop-ui run build
pnpm --filter @learningxxx/desktop-host run build
node apps/desktop/host/scripts/build-brand-app.mjs
```

Electron을 다른 작업 디렉터리에 이미 설치했다면 마지막 명령에 그 공식 `Electron.app` 절대 경로를 인자로 줍니다. 결과는 `apps/desktop/host/build/YOLO UNIV.app`입니다. Finder에서 열 수 있으며 빌드된 host/UI를 읽습니다. `.app`은 저장소에 넣지 않습니다.

이 앱은 **현재 소스 폴더를 참조하는 개발 런처**이며 독립 배포 파일이 아닙니다. 소스를 이동/삭제하면 원래 폴더를 복구하거나 그 위치에서 다시 만드세요. pnpm의 연결도 작업 폴더 이동 후 다시 설치해야 합니다. 런처 생성·시작 때 main 위치 기준 SDK/PDF 의존성을 검사하며 실패하면 시작을 중단하고 복구 안내를 표시합니다. 기존 런처가 있으면 덮어쓰지 않으니 필요하면 이전 것을 옮겨 둔 뒤 재생성합니다. 변환 실패 시 자기 임시 폴더만 정리합니다.

기존 앱이 실행 중이면 같은 데이터 폴더의 단일 실행 잠금으로 열린 창을 앞으로 가져옵니다. 새 브랜딩으로 전환하려면 진행 중인 녹음/채팅을 마친 뒤 기존 앱을 종료하고 새 런처를 여세요. 학교/Claude 권한 대화상자는 자동 승인하지 않습니다.

## 실제 검증과 자체 리뷰

- 화면·제목·메뉴 변경 diff와 기존 데이터/credential/session 호출을 검토. 내부 이름 변경 시 Safe Storage 서비스도 달라지는 것을 확인해 표시명과 내부 식별자를 분리했습니다.
- UI 133/133, host 249/249, 타입 검사·빌드 통과. 첫 실제 화면에서 어두운 테마에 남색 로고가 묻혀 밝은 타일 배경으로 수정하고 다시 빌드/시각 확인했습니다.
- worktree를 지속되는 위치로 옮긴 뒤 pnpm 링크를 재검증하지 않아 사용자가 SDK/core 모듈 누락 예외를 경험했습니다. offline frozen 재설치·빌드 후 Node에서 SDK/core 실제 import 성공, 런처 생성/시작 preflight와 오류 복구 안내를 추가하고 다시 실행했습니다.
- 공식 Electron 복사본으로 런처 생성, Plist 표시명/ICNS와 codesign --verify --deep --strict 통과. main의 절대 소스 경로·인용·기존 런처 보호·임시 정리를 재리뷰했습니다.
- 별도 합성 profile의 실제 앱 smoke: internalName=@learningxxx/desktop-host, userData/sessionData=지정한 같은 profile, title=YOLO UNIV, brandLoaded=true, hasNode=false, problems=[]; 넓은/좁은 레이아웃 overflowX=false. 첫 wide PNG는 compositor가 아직 그리지 않은 빈 프레임이었고, narrow PNG에서 로고·화면을 직접 확인했습니다. 홈의 F6 결과가 null이므로 이를 패널 이동 통과로 계산하지 않습니다.
- 수정된 실제 앱을 기존 프로필로 다시 열어 YOLO UNIV 창·앱 메뉴, 기존 6개 과목/저장공간 목록과 자동 로그인 켜짐을 확인했습니다. 로그인 비밀을 읽거나 다시 입력하지 않았습니다. 사람의 자가 QA를 수행했다고 기록하지 않습니다.
