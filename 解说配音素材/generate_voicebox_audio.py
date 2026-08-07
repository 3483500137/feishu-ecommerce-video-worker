import asyncio
import sys
from pathlib import Path

ROOT = Path(r"C:\Users\linzhiying\.codex\vendor_imports\voicebox")
sys.path.insert(0, str(ROOT))

from backend.backends.pytorch_backend import PyTorchTTSBackend
from backend.utils.audio import normalize_audio, save_audio


async def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(
            "usage: generate_voicebox_audio.py <script.txt> <reference.wav> <output.wav> <reference_text>"
        )

    script_path = Path(sys.argv[1])
    reference_path = Path(sys.argv[2])
    output_path = Path(sys.argv[3])
    reference_text = sys.argv[4]

    text = script_path.read_text(encoding="utf-8").strip()
    if not text:
        raise SystemExit("empty narration text")

    backend = PyTorchTTSBackend(model_size="0.6B")
    backend.model_size = "0.6B"
    voice_prompt, _ = await backend.create_voice_prompt(
        str(reference_path),
        reference_text,
        use_cache=True,
    )
    audio, sample_rate = await backend.generate(
        text=text,
        voice_prompt=voice_prompt,
        language="zh",
        seed=20260727,
        instruct="普通话产品演示解说，语速自然，清晰专业，情绪稳定。",
    )
    audio = normalize_audio(audio)
    save_audio(audio, str(output_path), sample_rate)
    backend.unload_model()
    print(output_path)


if __name__ == "__main__":
    asyncio.run(main())
