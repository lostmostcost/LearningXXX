# PLAN-091 · 설명 영상과 과제 초안

2026-11-04 / CR-091 / SPEC-006 v0.1.0 / REQ-009·012·013.

승인: 현재 채팅의 사용자 요청. Notion CR: https://app.notion.com/p/40dbd7ec20cd814dbf14ed63c9ed2a69

1. WBS-091: 외부 의존성이 없는 독립 생성 모듈. 검토 상태와 출처를 가진 자료 snapshot, 구조화 Claude 요청/응답 검증, 보고서 HTML·PPTX, 내레이션 어댑터와 HyperFrames 컴포지션·로컬 렌더. 실제 PDF 변환은 host 어댑터로 주입한다. 루트 manifest/lockfile 수정 없음.
2. WBS-092: WBS-083의 host/ui/shared claim 해제 후 앱 연결. 주차에 설명 영상 만들기, 과제 정보에 초안 만들기. 과목 연결은 현재 manifest·course.md·읽기 전용 사본을 재사용한다. 공식 Claude 구독 내용 생성, HeyGen 별도 음성 인증, 결과/출처/누락 검토 UI, 취소·복구·파일 열기를 연결한다. 문서는 Electron 인쇄 PDF, PPTX는 LibreOffice 등 설치된 변환기의 실제 변환 결과를 사용한다. 변환기 부재는 명확한 실패/설치 안내로 처리하고 HTML 인쇄를 PPTX 변환으로 속이지 않는다.
3. 통합 검증: 합성 입력 자동 검사 + 실제 Mac에서 한글 PDF·PPTX/PDF 글꼴/레이아웃과 짧은 MP4 음성 동기화 확인. 실제 Claude/TTS 호출은 설정과 명시 실행 후 기록. 실행하지 않은 항목은 미실행으로 유지한다.

## 병렬 경계
선행 WBS-078·082 live Done 확인. main aeb6b8b에 250f197(WBS-082) 포함. WBS-083은 In Progress, host/ui/shared claim 7edf435c. 신규 learning-artifacts와 pm만 선점하며 다른 claim ref는 변경하지 않는다. 기존 코드 작업 디렉터리 대신 /private/tmp/learningxxx-wbs091 사용.

## 자동/수동과 데이터
사용자가 대상/자료를 검토하고 생성 요청 → Claude가 근거 기반 초안 → 검증 → 문서/PPTX 변환 또는 대본 검토 뒤 유료 음성/로컬 MP4. 원본은 읽기 전용, 결과와 source hash만 로컬 실행 폴더에 저장. 실패 시 입력/대본은 보존하고 사용자가 다시 실행, 자동 과금 재시도 없음. LMS 제출은 기존 명시 확인 흐름이며 이 생성 작업 자체는 제출하지 않는다.

## 기술 근거
- https://github.com/heygen-com/hyperframes (HTML 결정적 렌더)
- https://github.com/heygen-com/hyperframes/blob/main/skills/media-use/audio/references/tts.md (HeyGen 직접 TTS; CLI tts는 Kokoro 전용이므로 hosted provider flag를 가정하지 않음)
- https://github.com/heygen-com/hyperframes/blob/main/docs/guides/authentication.mdx (음성 인증과 비용 분리)

구현/검사/자체 리뷰 결과는 진행 후 아래 기록한다. 계획만으로 완료 아님.


## WBS-091 구현·자체 리뷰 증거

모든 결과는 합성 자료로 실행. 실제 강의 원문/인증/음성 API 호출은 Git 또는 테스트에 넣지 않았다. 주요 기능 체크포인트 자가 QA를 수행한 것으로 표시하지 않는다.

| 단계/검토 파일 | 발견·원인·영향 | 수정·확인·재리뷰 |
| --- | --- | --- |
| 자료/계획: src/model.mjs, model.test.mjs, fixture.mjs | 얕은 freeze로 검토 후 본문 변형 가능. course 요약만으로 특정 주차 생성 가능. | 재귀 freeze, 실제 주차의 읽을 수 있는 source 필수. 과제 안내와 요구사항 추출도 필수. 5개 회귀 검사 통과 후 입력 범위/출처/호출 계약 재검토. |
| 문서: src/documents.mjs, documents.test.mjs | OOXML 문단 간격 속성 위치 오류, 긴 부록/출처 footer 넘침 위험. 초기 테스트가 fixture의 title과 body를 혼동해 실패. | 올바른 a:spcAft 노드, 부록 분할·짧은 출처 label, 테스트 기대 수정. HTML/XML escape·ZIP CRC/byte offset 검토. 실제 LibreOffice 25.2.3.2로 PPTX PDF 3쪽 생성, pdftotext 한글·출처 보존 확인, 첫 페이지 PNG 시각 확인. |
| 음성/영상: src/heygen.mjs, video.mjs, media.test.mjs | 실제 HyperFrames lint에서 audio id 누락(무음 위험), no-timeline/font 선언 누락 발견. TTS async credential 대기 뒤 계정이 바뀌면 요청될 수 있음. | audio 고유 id, data-no-timeline, local font-face. 인증 await 뒤 assertCurrent. 응답 제한·HTTPS 공급자 도메인/redirect 거부·API/원문 로그 미기록. lint 오류 0; 실제 2장면 3.5초 MP4의 audio/video, 두 프레임 한글·장면 전환 확인. 정적 설명 카드에 대한 subcomposition 권고 2개는 기능을 막지 않는 editor 구조 개선이므로 WBS-092 추적. |
| 실행/워크플로: src/runtime.mjs, workflow.mjs와 각 test | 비동기 metadata 저장 뒤 내용 생성 전에 계정 재검사 누락. 프로세스 부모만 종료하면 렌더 자식 잔존 위험. Finder PATH에서 Node/FFmpeg를 못 찾을 가능성. 변환기의 잘못된 파일 반환·큰 파일 signature 전체 읽기 위험. | 요청 직전/종료 직후 계정·취소 재검사, host AbortSignal 계약. POSIX process group TERM→KILL과 close시 잔존 worker 종료. 절대 Node 실행+host-configured PATH, 작은 header 읽기, 출력 폴더·PDF/MP4·stream/duration 검사. 중복 실행/취소/재시작/외부 결과/symlink 경계 검토 및 회귀 확인. |

실행 명령/결과:

- `node --test packages/learning-artifacts/test/*.test.mjs`: Node 24.22.2 macOS에서 24 passed, 0 failed (모든 수정 후 재실행). Node Docker 초기 단계 검사도 통과.
- `python3 scripts/check.py`: 92 tasks, 의존성 cycle 없음·scope/spec metadata 통과.
- `python3 -m unittest discover -s tests/tooling -v`: 20 tests, OK, 컨테이너 전용 설치 버전 검사 1 skipped. 제품 기능 테스트가 아니다.
- 별도 /private/tmp runtime에 `npm install --ignore-scripts --no-audit --no-fund hyperframes@0.9.9`. 저장소 manifest/lockfile과 전역 skill 미변경. `hyperframes doctor`: Node/FFmpeg/FFprobe/Chrome 통과, 미설치 Kokoro/Whisper/MusicGen은 이번 유료 API/시험음 경로에 불필요.
- 합성 sine 시험음 2개를 FFmpeg로 생성하고 `hyperframes lint /private/tmp/learningxxx-qa091/video`: 0 errors, 2 nonblocking subcomposition warnings. `hyperframes render --output explanation.mp4 --fps 30 --quality standard`: 실제 3.5s MP4. `ffprobe -show_entries stream=codec_type:format=duration -of json`: video+audio·3.500000s. FFmpeg 추출 0.5s/2s PNG 직접 시각 확인.
- `node packages/learning-artifacts/test/smoke-video.mjs <node> <hyperframes-cli> <ffprobe> <synthetic-tone.mp3> <output-root>`: 실제 ArtifactWorkflow→런타임→완료 status/result 생성 확인. 실제 Claude/TTS를 호출한 검사가 아니다.
- `node packages/learning-artifacts/test/smoke-document.mjs <Chrome> <output-root>`: 실제 Chrome headless 보고서 PDF 및 completed 상태. pdftotext/PNG 한글·레이아웃 확인.
- `docker run --rm -v <synthetic-root>:/work pptx-render:latest libreoffice -env:UserInstallation=file:///tmp/lo-wbs091 --headless --convert-to pdf --outdir /work/rendered /work/synthetic.pptx`: 실제 PPTX→PDF 3쪽 성공. 같은 이미지의 HTML 변환 시도는 writer 구성요소 부재로 실패했으며, 보고서 PDF는 Chrome 어댑터로 검증했다.

남은 범위: 앱 연결·실제 공식 Claude 구독 출력과 한국어 HeyGen voice/API 비용 검증·전체 자료 추출/명시 batch·긴 내용 레이아웃·PowerPoint/Keynote 편집 호환은 WBS-092. 입력 상한을 넘으면 현재 엔진은 명시 중단하며 전체 검토 성공이라고 표시하지 않는다. root pnpm workspace/CI에 신규 모듈 테스트는 아직 자동 등록되지 않아 별도 node test 명령이 필요하다. 실제 human QA 미실행.
