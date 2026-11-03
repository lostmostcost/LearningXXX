# Learning artifact engine · WBS-091

CR-091 / SPEC-006 v0.1.0 / REQ-009, REQ-012, REQ-013.

독립 Node 24 ESM 모듈이다. 외부 JS 의존성이 없으며 아직 desktop에 연결하지 않았다. WBS-083의 host/ui/shared claim과 충돌하지 않도록 root manifest·lockfile·공통 계약을 수정하지 않았다. WBS-092가 앱 버튼, 자료 추출, 공식 Claude 구독 runner, 설정·IPC·결과 열기를 연결한다. 이 디렉터리만으로 앱 기능 완료는 아니다.

## 제공하는 흐름

1. host가 현재 LMS 계정·과목을 확인하고 자료 본문을 읽기 전용 snapshot으로 제공한다. 영상은 주차+과목 요약, 과제는 전체 누적 자료+선택 과제 안내다. 자료마다 고유 id/title/kind/status/text 또는 누락 reason을 준다. 분할 PDF는 페이지·구간별 고유 source로 전달하고 원본 전체의 누락 구간을 숨기지 않는다.
2. `ArtifactWorkflow.prepare(input, {signal, allowMissing})`가 공식 구독 `generate` 어댑터를 호출한다. 각 읽을 수 있는 자료를 전부 검토 입력으로 전달하며 누락·한도 초과는 조용히 자르지 않는다. 검토된 계획과 source metadata가 반환된다. 이것은 완성된 파일이 아니다.
3. host가 대본·초안·요구사항·출처·미확인 사항을 사용자에게 보여준다. 확인 후 같은 `id/reviewToken`으로 `export`한다. 영상만 HeyGen TTS API에 대본을 보내고, 오디오를 실제 FFprobe로 측정해 HyperFrames로 로컬 MP4를 만든다. 과제 문서는 Chrome headless PDF, 발표는 편집 가능한 OOXML PPTX를 생성한 뒤 그 파일을 LibreOffice로 PDF 변환한다.
4. 실행별 새 폴더에 원본을 덮어쓰지 않고 `sources.json`(본문 제외 hash·누락 범위), `plan.json`, `status.json`, 출력·`result.json`을 보존한다. 폴더는 host가 지정한 로컬 root 아래 계정/과목 hash와 임의 run 이름이다. TTS credential·오디오 URL은 저장하지 않는다. renderer에는 필요한 필드만 골라 전달하고 host 파일 경로를 무조건 노출하지 않는다.
5. 실패·취소는 결과를 완료로 표시하지 않고 계획/부분 산출물을 남긴다. `inspect(directory)`는 재시작 후 비종료 작업을 interrupted로 읽으며 유료 호출을 재개하지 않는다. 자동 재시도 없음. 다시 만들기는 새 명시 요청이다. 이미 청구된 음성 비용은 취소로 환급되지 않을 수 있다.

## 연결 인터페이스

```js
import { ArtifactWorkflow } from './src/workflow.mjs';
import { createHeygenNarrator } from './src/heygen.mjs';
import { createMediaRuntime, createDocumentPdfPrinter, createPptxPdfConverter } from './src/runtime.mjs';

// All dependencies below are selected by the trusted host, never the renderer/model.
const workflow = new ArtifactWorkflow({
  root: artifactRoot,              // already-created private local directory
  accountId: () => currentAccountKey,
  generate: async ({ prompt, signal, assertCurrent }) => {
    assertCurrent();
    return officialSubscriptionTextRunner({ prompt, signal });
  },
  narrate: createHeygenNarrator({
    apiKey: () => hostCredentialStore.get('heygen'), // separate from Claude; no token extraction
    voiceId: configuredStarfishVoiceId,
    language: 'ko',
  }),
  media: createMediaRuntime({ node: absoluteNode, hyperframes: absoluteHyperframesCli, ffprobe: absoluteFfprobe }),
  documentPdf: createDocumentPdfPrinter({ chrome: absoluteChrome }),
  pptxPdf: createPptxPdfConverter({ libreoffice: absoluteLibreoffice }),
});
```

공식 CLI/SDK의 API 환경 거부·구독 preflight는 기존 runner에서 유지한다. host가 계정 변경·앱 종료·취소 시 해당 AbortController를 중단해야 한다. async 인증 preflight 후에도 `assertCurrent`를 호출한 다음 요청을 보내야 한다. 이 모듈의 검사만으로 OS 파일 접근 격리나 모델의 사실성을 보증하지 않는다. snapshot은 제공받은 자료만 확인하므로 host가 manifest 전체와 비교해 다운로드/텍스트 추출 누락을 표시해야 한다. 자료 원문에 포함된 지시를 실행하는 도구 권한을 생성 runner에 부여하지 않는다.

HeyGen Starfish voice ID와 별도 credential은 사용자가 설정한다. 현재 어댑터는 API key callback만 지원하며 OAuth credentials 파일을 읽거나 Claude credential을 사용하지 않는다. 실제 한국어 voice 유효성·과금·CDN 형식은 실제 호출 검증이 남았다. 다운로드는 HTTPS HeyGen 도메인만 허용하고 redirect/다른 공급자는 거부한다. 공급자가 다른 CDN을 반환하면 호스트/공식 계약 확인 후 명시 지원을 추가해야 한다.

HyperFrames **0.9.9**로 합성 로컬 MP4를 검증했다. 설치는 host 준비 단계이며 런타임이 `npx @latest`로 패키지/skill을 자동 설치하지 않는다. Node와 FFprobe의 디렉터리를 자식 PATH 앞에 넣어 Finder 실행의 PATH 차이를 줄인다. FFmpeg는 FFprobe와 같은 디렉터리 또는 host PATH에 있어야 한다. 리포트와 영상은 로컬 한글 글꼴이 필요하다. PPTX는 OOXML 텍스트로 편집 가능하지만 PowerPoint/Keynote의 전체 편집 호환성·긴 내용 레이아웃은 추가 실기 검사가 필요하다.

## 검사·직접 실행

```sh
node --test packages/learning-artifacts/test/*.test.mjs
python3 scripts/check.py
python3 -m unittest discover -s tests/tooling -v
```

별도 runtime 설치 후 합성 자료만으로 실제 출력할 수 있다. OUTPUT_ROOT를 먼저 만든다.

```sh
node packages/learning-artifacts/test/smoke-document.mjs /absolute/chrome /absolute/OUTPUT_ROOT
node packages/learning-artifacts/test/smoke-video.mjs /absolute/node /absolute/hyperframes-cli /absolute/ffprobe /absolute/synthetic-tone.mp3 /absolute/OUTPUT_ROOT
```

두 smoke는 실제 Claude·TTS를 호출하지 않는다. 자동 테스트의 fake PDF는 상태·경계 테스트용이며 PDF 렌더 검증으로 계산하지 않는다. 새 모듈 테스트는 아직 root workspace `pnpm -r check`에 자동 편입되지 않았으므로 위 명령을 별도 실행한다(WBS-092에서 root/shared claim 확보 후 등록).

현재 한도: source 2000개, source 본문 12만 자·전체 50만 자. 초과는 명시 중단한다. 자동 batch 검토는 후속 통합에서 구현/검증해야 한다. 영상 첫 구현은 장면별 정적 설명 카드+음성이다. 다이어그램·손글씨·수식·입체 애니메이션·단어별 자막은 아직 제공하지 않는다. 최대치 텍스트의 모든 슬라이드/장면 레이아웃을 실기 검증하지 않았다.
