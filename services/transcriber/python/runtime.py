"""Prepare/check only the public local engine; never opens a recording."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path


def cached_model(repo):
    from huggingface_hub import snapshot_download
    folder = Path(snapshot_download(repo, local_files_only=True, allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "*.jinja"]))
    if not (folder / "config.json").is_file():
        raise FileNotFoundError("model config")
    indices = list(folder.glob("*.safetensors.index.json"))
    files = set()
    for index in indices:
        files.update(json.loads(index.read_text())["weight_map"].values())
    if not files:
        files = {p.name for p in folder.glob("*.safetensors")}
    if not files or any(not (folder / p).is_file() or (folder / p).stat().st_size == 0 for p in files):
        raise FileNotFoundError("model weights")
    return folder


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    parser.add_argument("--model", choices=["Qwen/Qwen3-ASR-1.7B", "Qwen/Qwen3-ASR-0.6B"], required=True)
    parser.add_argument("--prepare", action="store_true")
    args = parser.parse_args()
    os.environ["HF_HOME"] = args.home
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    try:
        if importlib.metadata.version("mlx-qwen3-asr") != "0.4.4":
            raise ImportError("version mismatch")
        import mlx_qwen3_asr as engine
    except Exception:
        print(json.dumps({"ready": False, "reason": "dependencies"}))
        return 1
    try:
        if args.prepare:
            model = engine.load_model(args.model)
            del model
            aligner = engine.ForcedAligner("Qwen/Qwen3-ForcedAligner-0.6B")
            # The public constructor is lazy: actually align synthetic silence so
            # a first install fetches/loads its weights before declaring ready.
            import numpy as np
            aligner.align(np.zeros(16000, dtype=np.float32), "테스트", "Korean")
            del aligner
        cached_model(args.model)
        cached_model("Qwen/Qwen3-ForcedAligner-0.6B")
    except Exception:
        print(json.dumps({"ready": False, "reason": "models"}))
        return 1
    print(json.dumps({"ready": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
