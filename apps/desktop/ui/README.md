# Desktop UI — 자료 뷰어(WBS-013)·채팅(WBS-016)·선택 도구(WBS-018)

## 녹음·영상·전사 UI (WBS-026)

`TranscriptPanel.tsx`는 WBS-022의 Recording/MediaAsset/Transcript/TranscriptionJob을 받는 UI다. `transcript-model.ts`는 실제 수치를 가진 진행률만 표시하고, 전사 버전을 원본별로 분리하며, 타임스탬프 구간과 사용자가 고른 전사 행만 복사한다. 다른 과목/원본 연결과 빈 선택·과도한 길이는 거부한다. 원본 엔진 결과와 요청 보정본은 별도 버전이다. 자동 요약이나 AI 요청은 실행하지 않는다.

브라우저에서 `?mediaFixture`로 합성 예시를 연다(예: `http://localhost:4173/?mediaFixture`). 이 경로는 `window.host`가 없는 브라우저에서만 활성화된다. 생성한 10초 WAV 톤으로 원본 열기·구간 재생/정지를 확인하고, 영상/부분 복구 항목은 원본 없음 안내를 확인한다. 메타데이터는 합성이며 실제 강의 파일을 Git에 넣지 않는다. 예시 전사 상태로 대기·불확정 진행·완료·실패·취소를 바꿀 수 있다.

행 선택 → 미리보기 → 대상 확인 → 채팅 초안 넣기의 수동 흐름이다. 미리보기 당시 대상 세션 ID/이름과 전사 원본/버전/구간이 고정된다. 세션을 이후 바꿔도 다른 곳으로 보내지 않으며, 전사 버전/원본 변경은 선택과 미리보기를 초기화한다. 세션 없이 미리보면 넣기 버튼은 잠기고 세션 선택 후 새 미리보기가 필요하다. 실패 시 선택과 미리보기를 보존한다. 이 화면의 초안은 **샘플 초안**이며 현재 앱의 실제 ChatPanel/CLI로 전달하지 않는다.

`TranscriptPanelProps`가 WBS-027 통합 경계다. 검증된 원본 바이트를 Blob으로 주는 `loadOriginal`, 해당 실행의 전사 job을 재시도하는 `onRetry`, 고정된 대상 세션의 초안에 명시 선택만 추가하는 `onAttach(excerpt, targetSessionId)`를 host와 연결해야 한다. 원본은 renderer가 storageKey를 파일 경로로 열지 않고 Blob URL만 재생하며, 재선택/종료 시 URL을 해제한다. CSP의 media-src는 blob:만 허용한다. 다운로드 상태는 UI 투영 타입이고 collector/job API 계약을 새로 정의하지 않는다.

검증: 모델 회귀 및 UI 타입/빌드 검사, 합성 브라우저에서 선택/대상 고정·버전 변경 초기화·실제 WAV 구간 재생/정지·실패 재시도·원본 없음 안내. 미검증/후속: 실제 영상 코덱, 실제 녹음·다운로드·worker IPC 및 채팅 초안 저장 연결(WBS-027), 실제 Mac B 흐름 개발자 자가 테스트(WBS-028). 구간 끝 정지는 브라우저 timeupdate 간격만큼 오차가 있을 수 있다.

왼쪽 패널에 과목·주차·공지·과제를 보이고, 가운데 패널에서 선택한 자료를 연다. 근거: SPEC-003 v0.1.2(화면 원칙, 지원 형식 결정), SPEC-001(시간은 UTC 저장·서울 표시), WBS-003(A 단계는 PDF 우선).

| 모듈 | 내용 |
|---|---|
| `library.ts` | manifest를 과목 공지·주차별 목록·주차 없는 자료로 묶는다. 마감 표시(서울 시간, 48시간 이내 임박, 지남, 정보 없음). https 원문 링크만 허용 |
| `document.ts` | 자료별 화면 결정(PDF, 지원 안 함, 원본 없음, 공지, 과제)과 PDF 상태 문구 |
| `pdf.ts` | pdf.js로 PDF를 열고 선택 가능한 텍스트가 있는지 판정. 암호 문서·손상 파일 구분 |
| `pdf-browser.ts` | renderer용 pdf.js 설정(worker, 한글 CMap, 표준 글꼴, wasm 디코더 경로) |
| `LibraryPanel.tsx`, `Viewer.tsx`, `PdfView.tsx` | 화면. PDF는 쪽 이동·확대/축소 |
| `fixtures.ts`, `synthetic-pdf.ts` | 합성 과목과 합성 PDF. 실제 강의 자료는 넣지 않는다 |

## 화면별 동작
- **PDF:** 쪽 단위로 그린다. 텍스트가 하나도 없으면(스캔본) 텍스트 선택·번역을 쓸 수 없다고 알린다.
- **암호 PDF, 손상 파일:** 그리지 않고 원문 열기를 안내한다.
- **PDF 외 형식(PPTX 등):** 지원 형식(PDF)을 알리고 원문 열기를 안내한다. 변환·OCR은 하지 않는다.
- **원본 파일 없음:** 수집을 다시 실행하거나 원문 열기를 안내한다.
- **공지:** 계약에 본문이 없어 원문 열기로 LMS에서 확인한다.
- **과제:** 마감을 서울 시간으로 보인다. LMS가 시간대를 주지 않아 서울로 해석한 경우 그 사실을 함께 보인다. 제출 기능은 없고 제출 페이지 링크만 둔다.
- **원문 열기:** `https://` 링크만 `target="_blank"`로 연다. host가 기본 브라우저로 넘기고 앱 창은 이동하지 않는다. 직접 추가한 자료는 원문 링크가 없다.

## 데이터 (WBS-012)
앱 안에서는 host의 로컬 라이브러리를 읽는다: `library.courses`로 수집한 과목을 찾고 `library.manifest`로 목록을, `library.asset`으로 원본을 받는다. 원본은 manifest의 asset id로만 요청하므로 renderer가 파일 경로를 지정할 수 없고, host가 해시를 다시 확인한 뒤 돌려준다. 모두 로컬 디스크에서 읽어 오프라인에서도 열린다.
위쪽 `수집 실행` 버튼은 `collection.run`을 부르고, host가 보내는 `collection.progress`로 상태 줄을 바꾼다(`sync-status.ts`: 일부 실패는 성공으로 표시하지 않음, 로그인 만료 시 로그인 창 안내). 앱 밖(브라우저)에서는 수집 버튼이 없고, `?fixture`를 붙인 경우에만 합성 과목을 보인다.

## 보안 설정
`index.html` CSP에 pdf.js용으로 `worker-src 'self'`, `connect-src 'self'`(CMap·글꼴·이미지 디코더 파일), `img-src blob:`를 더했다. 외부 주소와 `unsafe-eval`(wasm 포함)은 여전히 허용하지 않는다. pdf.js 6에는 `eval`이 없고, WebAssembly 대신 JS 이미지 디코더(`useWasm: false`)를 쓴다. host의 boundary 테스트가 이 CSP를 검사한다.

## 직접 확인
```sh
pnpm install
pnpm --filter @learningxxx/desktop-ui build
pnpm --filter @learningxxx/desktop-ui exec vite preview
```
브라우저에서 `http://localhost:4173/?fixture`를 연다. Node가 없는 Mac이라면 컨테이너에서 빌드한 `dist`를 `python3 -m http.server`로 열어도 된다.

## 미검증
- Electron 앱(file://)에서 pdf.js worker와 CMap 파일 로딩. 브라우저(http)에서만 확인했다.
- 실제 강의 PDF 18개(한글 글꼴·CMap 포함) 표시. 합성 PDF는 영문 Helvetica만 쓴다.
- 실제 Claude 번역·설명 품질과 Electron에서 선택→CLI→응답까지의 통합 실행. 이번 확인은 합성 host만 사용하며 구독 계정을 호출하지 않았다.

## 채팅 (WBS-016)
| 모듈 | 내용 |
|---|---|
| `composer.ts` | 세션별 초안, 보내기 잠금 이유(세션 없음·보관됨·응답 중·첨부 준비 중·첨부 실패·빈 내용), 보낼 때 고정(`freeze`) |
| `chat.ts` | host 이벤트로 만든 대화 목록. `run.start` 응답보다 먼저 온 이벤트도 잃지 않음. 오류별 안내와 재시도 여부 |
| `ChatPanel.tsx` | 세션 목록·만들기(과목/독립)·이름 바꾸기·보관, 대화, 입력창 |
| `fake-host.ts` | `?fixture` 브라우저 전용 가짜 host. CLI·파일을 쓰지 않고 합성 응답만 흘린다 |

- **오발송 방지:** 초안은 세션마다 따로 있고, 보내기를 누른 순간 대상 세션과 내용이 고정된다. 이후 세션을 바꾸거나 글을 고쳐도 이미 보낸 요청은 바뀌지 않는다. 시작 전에 거절되면 글을 같은 세션 초안으로 돌려준다.
- **한 세션 한 응답:** 응답 중에는 그 세션의 보내기가 잠기고 이유를 보인다. 취소 버튼은 `run.cancel`을 부른다.
- **오류:** 사용량 한도는 다시 보낼 수 있는 시각을, 로그인·설치 문제는 해결 후 같은 내용으로 다시 보내기를, 세션 없음·격리 위반은 재시도 없이 이유를 보인다. 재시도는 새 requestId로 같은 고정 내용을 보낸다.
- **도구·권한:** CLI 도구 요청은 허용/거부/확인 필요로 표시한다. 앱 안 승인 화면은 아직 없다(CLI는 `dontAsk`로 미허용 도구를 거부).
- **독립 세션:** 과목 자료·이전 대화·메모를 보지 않는다는 안내를 항상 보인다.
- **첨부·캡처:** 첨부는 WBS-036, 캡처는 WBS-037. `화면 캡처`를 누르면 macOS 영역 선택(`screencapture -i`)이 열리고, Esc는 아무것도 남기지 않는다. 고른 영역은 미리보기(`capture-preview.ts`, data URL)와 함께 "캡처 확인"을 눌러야 보낼 수 있고, 보낼 때 `captureIds`로 따로 고정된다. 화면 기록 권한이 없으면 설정 위치를 안내하고, 도구 실패는 "다시 캡처"를 보인다. 확인하지 않은 캡처는 앱을 다시 열면 지워진다.
- **기록:** 대화 내용은 CLI가 보관한다. 앱 화면의 대화 목록은 이 창에서 보낸 것만이며 앱을 다시 열면 비어 있다.

## 선택 텍스트 번역·쉬운 설명 (WBS-018, REQ-006)

`PdfView.tsx`는 pdf.js의 공식 `TextLayer`를 캔버스 위에 겹친다. `selection.ts`는 현재 PDF 쪽 안에서 시작하고 끝난 범위만 받아 선택 문구(공백 제외 1~20,000자), asset ID, 쪽 번호를 만든다. 다른 패널까지 걸친 범위와 스캔본에는 선택 도구를 쓰지 않는다.

1. 과목 또는 독립 세션을 고르고 PDF 문장을 선택한다.
2. **영어 → 한국어 / 한국어 → 영어 / 쉽게 설명**을 누르면 그 순간 선택된 세션의 초안에 문구와 작업을 복사한다. 이 단계에서는 AI를 실행하지 않는다. 세션이 없으면 사용자가 세션을 고르고 **이 세션의 초안에 넣기**를 직접 눌러야 한다.
3. 초안에서 문구·쪽·작업을 확인하고 필요하면 질문을 추가하거나 작업을 바꾸고 **보내기**를 누른다. 기존 `run.start` 계약으로 명시한 문구와 위치를 전달하며 PDF 전체를 자동 첨부하지 않는다. 독립 세션에도 선택 문구만 추가한다.
4. 초안 또는 대화의 **원문 보기**는 해당 로컬 자료와 쪽을 연다. 자료가 목록에서 사라졌으면 재수집 안내를 보인다. 페이지/확대 변경은 기존 PDF 선택을 지우며 이미 보낸 문구는 바꾸지 않는다.

초안은 세션별로 유지하고 좁은 창에서 자료↔채팅을 바꾸어도 화면 상태를 유지한다. 실행 시작이 거절되면 선택 문구까지 같은 세션 초안에 복원하며 새로 입력한 초안은 덮어쓰지 않는다. 실패 시 기존 채팅의 오류 안내·재시도를 이용한다. 텍스트가 없는 PDF는 OCR을 수행하지 않는다.

합성 모드 직접 확인: 위 흐름으로 `불 대수 기초 (텍스트 PDF)`를 선택하여 전송하고, 다른 쪽으로 이동한 뒤 대화의 **원문 보기**로 돌아간다. 합성 응답에는 **실제 번역 아님**을 표시한다. `test/selection.test.ts`는 범위 경계, 세 가지 의도, 고정된 문구/대상 세션, 다른 초안 보존 및 실패 복원을 검사한다. 실제 기능의 개발자 자가 테스트는 A 흐름 체크포인트 WBS-020에서 수행한다.

## WBS-047 study shell
Start on the real-course dashboard; assignment dates do not imply submission status. Personal tasks are device-local and keyed by the unique account keys. The icon rail opens purpose tabs; hover/focus or click opens courses, and the pin keeps them visible. The top week handle supports pointer, focus and click with an Other materials fallback. Chat stays mounted across dashboard navigation. PDF defaults to page-fit using ResizeObserver content bounds, with width-fit/manual zoom. Existing explicit attachment and independent-session checks are unchanged. Design references: user sketch IMG_1270, Apple Preview's page/thumbnail navigation (https://support.apple.com/guide/preview/get-started-prvw846b61d3/mac), Claude desktop navigation (https://academy.claude.com/tutorials/navigating-the-claude-desktop-app). No third-party images or logos are bundled.
