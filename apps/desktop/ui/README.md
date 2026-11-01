# Desktop UI — 자료 뷰어 (WBS-013)

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

## 데이터
지금 host에는 과목 목록과 로컬 원본을 읽는 채널이 없다(WBS-012에서 연결). 그래서 앱은 빈 상태를 보이고, `?fixture`를 붙인 경우에만 합성 과목을 보인다. 자료 원본은 renderer가 직접 읽지 않고 `AssetLoader`로 받는다.

## 보안 설정
`index.html` CSP에 pdf.js용으로 `worker-src 'self'`, `connect-src 'self'`(CMap·글꼴 파일), `'wasm-unsafe-eval'`(이미지 디코더), `img-src blob:`를 더했다. 외부 주소는 여전히 허용하지 않는다. pdf.js 6에는 `eval`이 없다.

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
