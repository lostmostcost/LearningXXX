# Desktop UI — 자료 뷰어(WBS-013)·채팅(WBS-016)

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
- 텍스트 선택 레이어는 WBS-018에서 붙인다.

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
- **첨부·캡처:** 버튼은 있으나 비활성이다. host가 첨부를 전달하지 않기 때문이다(WBS-015는 첨부를 거부). 보내기 잠금 로직은 첨부 준비 중·실패 상태를 이미 처리한다.
- **기록:** 대화 내용은 CLI가 보관한다. 앱 화면의 대화 목록은 이 창에서 보낸 것만이며 앱을 다시 열면 비어 있다.
