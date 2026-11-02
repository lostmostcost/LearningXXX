# WBS-021 · STT 엔진 비교 실험

2026-11-02, 이문찬 Mac(M1, 16GB, macOS 26). 결정: [ADR-003](../../docs/decisions/ADR-003-stt-engine.md).

## 후보와 제외 이유

| 후보 | 결과 |
|---|---|
| whisper.cpp + large-v3-turbo (Metal, Silero VAD) | 비교 |
| Qwen3-ASR 1.7B (mlx-qwen3-asr 0.4.4, Apache 2.0) | 비교 |
| Raon-Speech 9B (KRAFTON) | 제외: 9B 음성 대화 모델, bf16 약 18GB로 16GB Mac 초과, Mac 실행 경로 미확인, CC BY-NC |
| Soniox | 제외: 클라우드 API만 있음(유료 키·녹음 외부 전송 필요) |
| Apple SpeechAnalyzer | 이번에는 미실행 |

## 표본

실제 강의 녹음 3개에서 10분씩(16kHz mono). 녹음과 전사는 비공개라 저장소 밖에만 두었다.

| 표본 | 성격 |
|---|---|
| DB | 온라인 강의 영상, 깨끗한 음성, 영어 외래 전문용어 많음 |
| 논리회로 | 온라인 강의 영상, 깨끗한 음성, 전문용어 |
| 대면 | 강의실 녹음(초청 강연), 잔향·거리·말 겹침 |

## 결과

처리 시간과 최대 메모리(`/usr/bin/time -l`, 모델 다운로드·첫 실행 제외):

| 표본 | whisper.cpp | Qwen3-ASR | Qwen3-ASR + 단어 타임스탬프 |
|---|---|---|---|
| DB | 92s · 2.1GB | 150s (용어 힌트) | 337s · 4.0GB |
| 논리회로 | 118s · 2.1GB | 210s · 3.7GB (용어 힌트) | 228s · 3.9GB |
| 대면 | 144s · 2.1GB | — | 230s · 4.2GB |

디스크: whisper 모델 1.6GB, Qwen3-ASR 캐시(1.7B·0.6B·정렬 모델) 6.1GB.

품질(사람 기준 전사가 없어 CER은 미측정. 같은 구간을 나란히 비교한 판단):
- **온라인 강의**: 둘 다 문장이 자연스럽고 누락이 거의 없다. whisper는 외래어를 영어로 섞어 쓰는 경향("Relation"), Qwen은 힌트 없이 일부 외래 용어를 틀림. **용어 힌트**(whisper `--prompt`, Qwen `--context`)를 주면 둘 다 과목 용어를 한글 표기로 정확히 씀.
- **대면 녹음**: Qwen이 뚜렷이 나음. whisper는 일상 단어를 소리가 비슷한 다른 단어로 바꾸는 오류가 잦고, 말하지 않은 화자 표시를 만든 구간이 있음. Qwen도 오류가 남아 이후 보정이 필요함.
- 긴 침묵·반복 환각: 두 엔진 모두 이번 표본에서는 없음(반복 문장 0~1개).

## 재현

```bash
spikes/stt/setup.sh                       # ../.learningxxx-toolchain/stt 에 설치
spikes/stt/compare.sh <녹음> <시작초> <저장소 밖 폴더> "용어1 용어2"
```

## 남은 확인

- 8GB Mac(안상현)에서의 메모리: Qwen3-ASR 8bit 또는 0.6B로 시험 필요(WBS-025).
- 사람 기준 전사로 CER 측정(대면 녹음 2~3분)은 WBS-028 자가 테스트 때.
