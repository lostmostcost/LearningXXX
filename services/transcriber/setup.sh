#!/bin/sh
# Installs the transcription engine (ADR-003) into the app's own folder, never
# system-wide: a Python virtual environment with a pinned mlx-qwen3-asr, and the
# model weights for this Mac (1.7B, or 0.6B with 8GB of memory or less).
# Usage: services/transcriber/setup.sh [STT_DIR]
#   default: ~/Library/Application Support/@learningxxx/desktop-host/stt
set -eu
DIR="${1:-$HOME/Library/Application Support/@learningxxx/desktop-host/stt}"
mkdir -p "$DIR"
if [ ! -x "$DIR/.venv/bin/python" ]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv -q --python 3.13 "$DIR/.venv"
  else
    PY="$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || true)"
    [ -n "$PY" ] || { echo "Python 3.10 이상 또는 uv가 필요합니다: brew install uv" >&2; exit 2; }
    "$PY" -m venv "$DIR/.venv"
  fi
fi
if command -v uv >/dev/null 2>&1; then
  VIRTUAL_ENV="$DIR/.venv" uv pip install -q "mlx-qwen3-asr[aligner]==0.4.4"
else
  "$DIR/.venv/bin/python" -m pip install -q "mlx-qwen3-asr[aligner]==0.4.4"
fi
MEM=$(sysctl -n hw.memsize)
MODEL=Qwen/Qwen3-ASR-1.7B
[ "$MEM" -le 8589934592 ] && MODEL=Qwen/Qwen3-ASR-0.6B
# Fetch the weights now so the first lecture does not wait on a download.
HF_HOME="$DIR/hf" HF_HUB_DISABLE_TELEMETRY=1 "$DIR/.venv/bin/python" -I -c "import mlx_qwen3_asr as m; m.load_model('$MODEL'); m.ForcedAligner('Qwen/Qwen3-ForcedAligner-0.6B') if hasattr(m, 'ForcedAligner') else None" >/dev/null 2>&1 || true
echo "전사 엔진 준비 완료: $DIR ($MODEL)"
