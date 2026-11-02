"""Transcribes one 16 kHz mono WAV with Qwen3-ASR (ADR-003) and reports on stdout.

Run by the host in the app's own virtual environment, never system-wide.
Output is JSON lines, nothing else on stdout:
  {"type": "progress", "value": 0.42}     real fraction of audio processed
  {"type": "result", "language": "...", "text": "...", "words": [{"text", "start", "end"}]}
`words` come from the forced aligner without spacing or punctuation; `text`
is the full transcript with both, so the host can rebuild readable segments.
Errors go to stderr with a non-zero exit code: 3 = the engine cannot be
loaded, 4 = the audio cannot be read, 1 = anything else.
"""

import argparse
import json
import sys
import wave


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_wav(path):
    """16 kHz mono 16-bit WAV (made by afconvert) as float32 samples.

    Read here rather than by mlx_qwen3_asr.load_audio, which needs ffmpeg.
    """
    import numpy as np

    with wave.open(path, "rb") as f:
        if f.getframerate() != 16000 or f.getnchannels() != 1 or f.getsampwidth() != 2:
            raise ValueError("expected 16 kHz mono 16-bit WAV")
        frames = f.readframes(f.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", default="Korean")
    parser.add_argument("--context", default="")
    args = parser.parse_args()

    try:
        import mlx_qwen3_asr
    except Exception as error:  # noqa: BLE001 - any import failure means no engine
        sys.stderr.write(f"engine unavailable: {error}\n")
        return 3

    try:
        audio = (read_wav(args.wav), 16000)
    except Exception as error:  # noqa: BLE001
        sys.stderr.write(f"audio unreadable: {error}\n")
        return 4

    def on_progress(payload):
        if payload.get("event") == "chunk_completed" and "progress" in payload:
            emit({"type": "progress", "value": float(payload["progress"])})

    result = mlx_qwen3_asr.transcribe(
        audio,
        model=args.model,
        context=args.context,
        language=args.language,
        return_timestamps=True,
        on_progress=on_progress,
    )
    words = [
        {"text": str(s["text"]), "start": float(s["start"]), "end": float(s["end"])}
        for s in (result.segments or [])
    ]
    emit({"type": "result", "language": result.language or args.language, "text": result.text, "words": words})
    return 0


if __name__ == "__main__":
    sys.exit(main())
