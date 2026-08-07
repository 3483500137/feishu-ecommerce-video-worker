import asyncio
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(r"C:\Users\linzhiying\.codex\vendor_imports\voicebox")
sys.path.insert(0, str(ROOT))

from backend.backends.pytorch_backend import PyTorchTTSBackend
from backend.utils.audio import normalize_audio, save_audio


REFERENCE_TEXT = "这是一段用于本地配音的中文参考音色。语速稳定，发音清楚，适合用于产品功能演示解说。"
INSTRUCT = "普通话产品演示解说，语速自然，清晰专业，情绪稳定。"


def ass_time(seconds: float) -> str:
    cs = int(round(seconds * 100))
    h = cs // 360000
    cs %= 360000
    m = cs // 6000
    cs %= 6000
    s = cs // 100
    cs %= 100
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def wrap_ass(text: str, width: int = 22) -> str:
    lines = []
    current = ""
    for ch in text:
        current += ch
        if len(current) >= width and ch in "，。；、":
            lines.append(current)
            current = ""
    if current:
        lines.append(current)
    if len(lines) == 1 and len(lines[0]) > width:
        text = lines[0]
        lines = [text[i : i + width] for i in range(0, len(text), width)]
    return r"\N".join(lines[:2])


def write_ass(path: Path, events: list[tuple[float, float, str]]) -> None:
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default, Microsoft YaHei, 48, &H00FFFFFF, &H00FFFFFF, &H00000000, &H80404040, 0, 0, 0, 0, 100, 100, 0, 0, 4, 12, 0, 2, 120, 120, 56, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    for start, end, text in events:
        lines.append(
            f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{wrap_ass(text)}\n"
        )
    path.write_text("".join(lines), encoding="utf-8-sig")


async def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: generate_voicebox_narration_assets.py <script.txt> <reference.wav> <out_dir>")

    script_path = Path(sys.argv[1])
    reference_path = Path(sys.argv[2])
    out_dir = Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)

    chunks = [line.strip() for line in script_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not chunks:
        raise SystemExit("empty narration text")

    backend = PyTorchTTSBackend(model_size="0.6B")
    backend.model_size = "0.6B"
    voice_prompt, _ = await backend.create_voice_prompt(str(reference_path), REFERENCE_TEXT, use_cache=True)

    pieces = []
    events = []
    cursor = 0.0
    silence_sr = 24000
    silence = np.zeros(int(silence_sr * 0.28), dtype=np.float32)

    for index, text in enumerate(chunks, 1):
        print(f"generating segment {index}/{len(chunks)}: {text[:24]}", flush=True)
        audio, sample_rate = await backend.generate(
            text=text,
            voice_prompt=voice_prompt,
            language="zh",
            seed=20260727 + index,
            instruct=INSTRUCT,
        )
        audio = normalize_audio(audio)
        segment_path = out_dir / f"voicebox_segment_{index:02d}.wav"
        save_audio(audio, str(segment_path), sample_rate)

        if sample_rate != silence_sr:
            silence_sr = sample_rate
            silence = np.zeros(int(silence_sr * 0.28), dtype=np.float32)

        duration = len(audio) / sample_rate
        events.append((cursor, cursor + duration + 0.1, text))
        pieces.append(audio.astype(np.float32))
        pieces.append(silence)
        cursor += duration + len(silence) / sample_rate

    merged = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)
    narration_path = out_dir / "voicebox_narration.wav"
    save_audio(merged, str(narration_path), silence_sr)
    write_ass(out_dir / "subtitles.ass", events)
    backend.unload_model()
    print(narration_path)
    print(out_dir / "subtitles.ass")


if __name__ == "__main__":
    asyncio.run(main())
