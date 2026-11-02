#!/bin/sh
# WBS-021: runs both engines on one 10-minute clip of a lecture recording and
# prints time and peak memory. Transcripts go to OUT_DIR, which must be outside
# the repository: they are private course content and are never committed.
# Usage: spikes/stt/compare.sh AUDIO START_SECONDS OUT_DIR [TERMS]
#   TERMS: space-separated course terms passed as a hint to both engines.
set -eu
AUDIO="$1"; START="$2"; OUT="$3"; TERMS="${4:-}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STT_HOME="${STT_HOME:-$REPO/../.learningxxx-toolchain/stt}"
case "$(cd "$(dirname "$OUT")" 2>/dev/null && pwd)/" in "$REPO"/*) echo "OUT_DIR must be outside the repository" >&2; exit 2 ;; esac
mkdir -p "$OUT"
NAME="$(basename "$AUDIO" | sed 's/\.[^.]*$//' | tr -c 'A-Za-z0-9가-힣\n' '_')"
CLIP="$OUT/$NAME.wav"
ffmpeg -v error -y -ss "$START" -t 600 -i "$AUDIO" -ar 16000 -ac 1 "$CLIP"

measure() { # label, command...
  label="$1"; shift
  /usr/bin/time -l "$@" >"$OUT/$label.log" 2>"$OUT/$label.err"
  secs=$(awk '/ real /{print $1}' "$OUT/$label.err")
  rss=$(awk '/maximum resident set size/{printf "%.1f", $1/1073741824}' "$OUT/$label.err")
  printf '%s\t%s\t%ss\t%sGB\n' "$NAME" "$label" "$secs" "$rss"
}

measure whisper "$STT_HOME/whisper.cpp/build/bin/whisper-cli" -m "$STT_HOME/models/ggml-large-v3-turbo.bin" -l ko -t 8 \
  --vad -vm "$STT_HOME/models/ggml-silero-v5.1.2.bin" ${TERMS:+--prompt "$TERMS"} -oj -otxt -of "$OUT/$NAME.whisper" -f "$CLIP"

. "$STT_HOME/.venv/bin/activate"
export HF_HOME="$STT_HOME/hf"
measure qwen mlx-qwen3-asr --model Qwen/Qwen3-ASR-1.7B --language Korean ${TERMS:+--context "$TERMS"} \
  -o "$OUT/$NAME.qwen" -f txt --no-progress "$CLIP"
measure qwen+timestamps mlx-qwen3-asr --model Qwen/Qwen3-ASR-1.7B --language Korean ${TERMS:+--context "$TERMS"} \
  --timestamps -o "$OUT/$NAME.qwen-ts" -f json --no-progress "$CLIP"
