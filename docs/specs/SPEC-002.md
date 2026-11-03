# SPEC-002 · 구독 CLI·세션·파일 격리

Source: https://app.notion.com/p/40bbd7ec20cd81079a4cc94ae75e8a21?pvs=204
Snapshot: 2026-11-03 · v0.3.1 · Notion is authoritative; refresh after approved changes.

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


## CR-050 · 일반 Claude Code 대화형 실행 (이전 절보다 우선)
사용자 직접 승인: 모든 명령 지원을 위해 새 native 세션은 -p 대신 공식 interactive CLI를 PTY로 실행한다. / 목록·스킬·권한·모델·문맥 압축·재개를 앱에서 흉내 내거나 필터하지 않는다. 독립 세션도 일반 Claude 환경으로 바꾸며 격리를 보장하지 않는다. 과거의 고정 격리 정책과 G0 증거는 기존 structured 세션에만 유지한다. 새 경로의 통과 증거로 승계하지 않는다.
세션 engine=native를 분리 저장하고 과거 기록은 마이그레이션하지 않는다(사용자 초기화 승인). native 세션은 별도 시작 폴더를 갖지만 글로벌 Claude 설정/기억/플러그인과 CLI의 명시적 다른 세션 resume를 허용한다. 구독 인증 preflight·API 환경 거부·권한 우회 미사용을 유지하며 --permission-mode default로 시작한다. 이후 권한 선택은 CLI 화면에서 사용자가 한다. native 파일 조작에 과거 host 파일 UI의 폴더 제한·trash-only·자동 복구 보장을 적용한다고 표시하지 않는다.
SessionStart 훅은 session_id UUID와 이력 파일 위치만 원자적으로 저장하여 /clear,/resume 변경 후 재연결에 사용한다. 대화 본문·토큰·자격증명을 훅 파일에 저장하지 않는다. 훅이 꺼져 매핑이 없으면 해당 시작 폴더 --continue를 사용한다. 처음부터 기존 structured 이력을 native에 자동 주입하지 않는다.
PTY는 host가 고른 공식 실행 파일만 실행하고 renderer는 path/args/env를 지정하지 못한다. IPC 입력 크기·터미널 크기·동시 프로세스·재생 버퍼를 제한한다. 화면 전환은 연결만 분리하고 CLI는 유지한다. 명시 종료·앱 종료는 프로세스를 중단한다. 출력은 메모리의 제한된 재생 버퍼이며 실제 대화 이력은 Claude Code가 관리한다. 중단된 입력을 앱이 자동 재전송하지 않는다.


## CR-051 · 공식 SDK 채팅과 고급 터미널
사용자 직접 승인: 채팅을 기본 화면으로, 터미널은 고급 도구로 유지한다. host의 공식 Agent SDK 0.3.301이 설치된 공식 CLI를 실행하며 구독 로그인 preflight/API 환경 거부와 일반 전역 설정·기억·스킬 허용(CR-050)을 유지한다. API 키/토큰 추출/서버 인증은 사용하지 않는다. 새 engine=chat은 이전 기록을 마이그레이션하지 않는다.
모델·강도는 엔진이 제공하는 값만 선택하고 실제 제어 API로 변경한다. 일반·계획·편집 자동 승인과 해당 모델/엔진이 허용하는 자동 모드를 제공한다. 기본 일반 모드이며 앱이 bypassPermissions/dontAsk를 선택하지 않는다. 권한·질문은 세션별 명시 카드로 응답하고 취소/종료 시 거부한다. SDK와 PTY를 동일 세션에서 동시에 실행하지 않는다. 고급 화면 전환은 현재 연결을 종료한 뒤 같은 CLI 세션 ID로 재개하며 원본 이력을 읽어 표시를 맞춘다.
전송 UUID는 불명확한 응답 후 같은 내용 재시도에도 유지해 중복 실행을 막는다. 취소는 SDK에 아직 전달하지 않은 입력과 엔진 대기 입력도 중단하고 확인할 수 없으면 연결을 종료한다. 자동 재전송하지 않는다. 파일 복구는 엔진 체크포인트 미리보기와 명시 확인 후 실행한다. 새 파일은 삭제될 수 있으며 Bash·외부 변경·대화 문맥은 복구하지 않는다. 일반 파일 도구에 과거 host trash-only 보장을 표시하지 않는다. 사용량 조회는 공식 SDK의 실험 API를 분리해 사용하며 실패를 미조회로 표시한다.
CR: https://app.notion.com/p/40dbd7ec20cd814aaefff0ff176ee897 · WBS-051. 실제 SDK 구독 사용 근거: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan (확인 2026-11-03).


## CR-052 · 세션 과목의 수집 자료 연결
과목 세션 사용을 해당 courseId의 수집 자료 기본 조회 선택으로 처리한다. 현재 LMS 계정과 과목을 검사하고 검증한 읽기 전용 사본을 세션별 버전 폴더에 준비한다. 작업 폴더의 course 링크는 INDEX.md·catalog.json·materials를 제공하며 outputs는 결과물 폴더다. 전체 본문을 주입하거나 인증·storageKey·서명 URL·관리 DB를 노출하지 않는다. 일반 세션에는 연결하지 않는다. 구독 로그인과 일반 Claude 환경/격리 보장 없음은 유지한다.
SDK 시작에 고정 과목 안내를 추가하고 전송 전 사본 갱신 및 UserPromptSubmit에서 최신 버전 문맥을 전달한다. PTY는 시작 안내와 제출 전 갱신, 실제 UserPromptSubmit 훅으로 같은 연결을 사용한다. 명령을 재해석하거나 키 입력을 주입하지 않는다. 비동기 갱신 중 입력을 순서대로 전달한다. 계정 변경·미수집·손상·폴더 경계 변경은 전송 전에 중단/안내한다. 기존 사용자 course/outputs는 덮어쓰지 않는다.
갱신은 새 사본을 만든 뒤 링크를 원자 교체하며 이전 사본은 진행 중 참조를 위해 보존한다. 자동 정리(GC)는 이번 범위 밖이다. 수집/요약은 요청 시에만 실행하고 수집된 로컬 자료는 오프라인으로 읽는다.
CR: https://app.notion.com/p/40dbd7ec20cd81fd998de3d67036be2a · WBS-052.
