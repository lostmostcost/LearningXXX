# SPEC-002 · 구독 CLI·세션·파일 격리

Source: https://app.notion.com/p/40bbd7ec20cd81079a4cc94ae75e8a21?pvs=204
Snapshot: 2026-11-01 · v0.1.1 · Notion is authoritative; refresh after approved changes.

## 실행 전략과 검증 경계
REQ-001/004/005/009. 각자의 Mac에 설치·로그인된 공식 Claude Code CLI를 앱의 host process가 실행한다. 서버에 두 사람의 Claude 인증을 올리지 않는다. CLI의 JSON/stream 출력과 명시적 session ID 기반 재개를 후보로 사용한다. 프로세스가 매 요청 끝나도 session ID를 보존하면 논리적 세션은 유지할 수 있다. 프로세스 상주와 세션 지속을 혼동하지 않는다.
공식 문서는 비대화형 실행과 재개를 제공한다. 구독 인증·도구 권한·실제 macOS 앱 실행 문맥은 G0 테스트로 입증해야 한다. 특히 독립 세션은 프롬프트에 '이전 자료를 보지 말라'만 쓰는 방식으로 구현하지 않는다.

## 공식 근거
[프로그램 실행](https://code.claude.com/docs/en/headless), [인증](https://code.claude.com/docs/en/authentication), [구독 플랜 사용](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan).
문서 확인일 2026-11-01. 현재 문서에서 --bare는 구독 로그인을 사용하지 않는다고 안내하므로 구독 전용 설계의 격리 해결책으로 채택하지 않는다. 실제 설치 버전과 플래그를 G0 결과에 기록한다. CLI/정책 변경 시 이 ADR을 다시 검증한다.

## 세션 모델
Session: appSessionId, courseId?, mode(course|independent), cliSessionId?, workspacePath, title, createdAt, lastUsedAt, archivedAt?, status.
Run: runId, appSessionId, requestId, startedAt, endedAt?, status, exitCode?, errorCode?.
Attachment: id, runId, sourceAssetId?, userConfirmed, contentHash, localPath, provenance.
한 과목의 여러 세션을 목록으로 보인다. 보관은 숨김이며 삭제나 CLI 기억 초기화와 같지 않다. 앱은 세션 매핑과 실행 관리만 책임지고 CLI 내부 대화 이력을 임의 편집하거나 매 턴 자체 요약을 끼워넣지 않는다.

## 실행 수명주기
idle → starting → streaming → awaiting_permission 또는 completed/failed/cancelled.
동일 세션에는 실행 하나만 허용한다. requestId로 중복 클릭을 막는다. stdout는 이벤트 파서, stderr는 진단으로 분리한다. 종료 코드와 응답 오류를 함께 판정한다. 앱 재시작 시 running은 interrupted로 복구하고 변경 작업을 무조건 재전송하지 않는다. 취소 시 프로세스 종료와 결과물 존재 여부를 확인한다. 사용량 제한, 인증 만료, 설치 없음, 잘못된 session ID, 버전 불일치를 각기 설명한다.

## 구독 인증 조건
사용자가 공식 CLI 로그인 절차를 완료한다. host는 API 키·클라우드 공급자 인증 설정이 선택되지 않았는지 점검한다. 인증 정보는 CLI/OS가 관리하고 UI renderer·서버·로그로 전달하지 않는다. 구독 경로 실패 시 명확히 중단하며 유료 API로 자동 fallback하지 않는다. 구독 실제 적용 여부를 확인한 증거는 민감값을 가리고 기록한다.

## 과목 세션과 독립 세션
과목 세션의 기본 정보 범위는 과목 이름과 사용자가 선택한 자료 중심으로 시작하는 제안이다. 전체 학기 파일을 무조건 전송하지 않는다.
독립 세션의 UI courseId는 탐색 위치일 뿐 입력 문맥이 아니다. 새 cliSessionId, 빈 전용 작업 디렉터리, 명시 첨부만 허용한다. 과목 파일·기존 대화·추출 메모·요약·자동 검색 인덱스·기존 세션 resume를 전달하지 않는다. 부모 폴더 설정, CLAUDE.md, 글로벌 메모리, MCP, hooks, 추가 디렉터리와 심볼릭 링크 접근도 누출 경로로 검사한다. 같은 디렉터리 안에서 새 대화만 만드는 방식은 불충분하다.
구독 로그인을 유지하면서 이 접근 경계를 실제로 강제할 수 있는지 G0에서 확인한다. CLI 권한 설정은 보안 경계라고 가정하지 않는다. 격리 검증 실패 시 REQ-005 완료로 표시하지 않고 설계 변경을 협의한다.

## 파일 작업
생성/수정은 앱 workspace와 사용자가 명시적으로 선택한 외부 폴더에서 수행한다. 선택하지 않은 외부 폴더에는 권한을 확장하지 않는다. 원본 학습 자료는 읽기 전용으로 보존하고 산출물은 outputs 아래 버전 관리한다. 삭제는 사용자의 확인 후 macOS 휴지통으로 이동한다. 앱 기능으로 영구 삭제하지 않는다. 경로 정규화·상위 탈출·symlink·외부 경로를 검사한다. 광범위한 Bash 자동 허용으로 이를 무력화하지 않는다. G0에서는 별도 disposable fixture만 생성·수정·삭제한다.
변경 전 대상·의도, 변경 후 파일 목록·요약·복구 방법을 보인다. 삭제 확인에는 대상 경로를 표시한다. 선택한 외부 폴더 권한이 독립 세션에 자동 승계되지 않도록 세션별 명시 입력·접근 범위와 분리한다.

## 수용 시나리오
같은 세션 재개 시 테스트 사실을 회상하고 다른 세션에 섞이지 않는다. 독립 세션은 이전 과목의 고유 canary 문자열을 요청·파일 접근·답변 어디에서도 얻지 못해야 한다. 사용자가 canary 파일을 직접 첨부하면 그때만 참조 가능하다. 이는 모델 답변 한 번만 보는 테스트가 아니라 전달 payload·실제 도구 접근·작업 경로를 함께 관찰하는 검사다.
API 환경변수가 존재하는 환경, 로그인 만료, usage limit, 취소 중 파일 변경, 앱 강제 종료를 테스트한다. 성공한 호출 횟수와 버전·권한 설정·미검증 범위를 남긴다.

