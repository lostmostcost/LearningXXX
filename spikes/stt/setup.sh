#!/bin/sh
# WBS-021: installs both STT candidates outside the repository, in an isolated
# folder (no system-wide packages). Re-running is safe.
# Usage: spikes/stt/setup.sh [STT_HOME]   default: ../.learningxxx-toolchain/stt
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STT_HOME="${1:-$REPO/../.learningxxx-toolchain/stt}"
WHISPER_COMMIT=482279b
mkdir -p "$STT_HOME/models"
cd "$STT_HOME"

# Qwen3-ASR (MLX) and cmake for whisper.cpp, in one virtual environment.
[ -d .venv ] || uv venv -q --python 3.13 .venv
. .venv/bin/activate
uv pip install -q cmake "mlx-qwen3-asr[aligner]==0.4.4"

# whisper.cpp with Metal, pinned.
[ -d whisper.cpp ] || git clone -q https://github.com/ggml-org/whisper.cpp
git -C whisper.cpp checkout -q "$WHISPER_COMMIT"
(cd whisper.cpp && cmake -B build -DGGML_METAL=ON -DWHISPER_SDL2=OFF -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build build -j 8 --target whisper-cli >/dev/null)

fetch() { [ -s "models/$1" ] || curl -fsSL -o "models/$1" "$2"; }
fetch ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
fetch ggml-silero-v5.1.2.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
echo "ready: $STT_HOME (Qwen3-ASR weights download on first run into $STT_HOME/hf)"
