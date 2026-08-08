import json
from pathlib import Path

import numpy as np
import soundfile as sf


BASE = Path(__file__).resolve().parent
PAUSE_SECONDS = 0.28


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


def write_ass(path: Path, events: list[dict]) -> None:
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default, Microsoft YaHei, 48, &H00FFFFFF, &H00FFFFFF, &HFF000000, &H90404040, 0, 0, 0, 0, 100, 100, 0, 0, 4, 14, 0, 2, 120, 120, 56, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    for event in events:
        lines.append(
            f"Dialogue: 0,{ass_time(event['start'])},{ass_time(event['end'])},Default,,0,0,0,,{wrap_ass(event['text'])}\n"
        )
    path.write_text("".join(lines), encoding="utf-8-sig")


def read_audio(path: Path) -> tuple[np.ndarray, int]:
    audio, sample_rate = sf.read(path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio, sample_rate


def main() -> None:
    original_lines = [
        line.strip()
        for line in (BASE / "narration.txt").read_text(encoding="utf-8-sig").splitlines()
        if line.strip()
    ][:11]
    addendum_lines = [
        line.strip()
        for line in (BASE / "narration_addendum.txt").read_text(encoding="utf-8-sig").splitlines()
        if line.strip()
    ]

    audio_specs = []
    for index, text in enumerate(original_lines, 1):
        audio_specs.append((BASE / f"voicebox_segment_{index:02d}.wav", text, "main"))
    for index, text in enumerate(addendum_lines, 1):
        phase = "case" if index in (9, 10, 11) else "main"
        if index >= 12:
            phase = "dashboard"
        audio_specs.append((BASE / "addendum" / f"voicebox_segment_{index:02d}.wav", text, phase))

    pieces = []
    events = []
    cursor = 0.0
    sample_rate_out = None
    for path, text, phase in audio_specs:
        if not path.exists():
            raise FileNotFoundError(path)
        audio, sample_rate = read_audio(path)
        if sample_rate_out is None:
            sample_rate_out = sample_rate
        if sample_rate != sample_rate_out:
            raise ValueError(f"mixed sample rates: {path} has {sample_rate}, expected {sample_rate_out}")
        duration = len(audio) / sample_rate
        events.append({"start": cursor, "end": cursor + duration + 0.1, "text": text, "phase": phase})
        pieces.append(audio)
        pieces.append(np.zeros(int(sample_rate * PAUSE_SECONDS), dtype=np.float32))
        cursor += duration + PAUSE_SECONDS

    merged = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)
    sf.write(BASE / "voicebox_narration_final.wav", merged, sample_rate_out or 24000)
    write_ass(BASE / "subtitles_final.ass", events)
    (BASE / "subtitle_events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")

    case_start = next(event["start"] for event in events if event["phase"] == "case")
    dashboard_start = next(event["start"] for event in events if event["phase"] == "dashboard")
    print(f"duration={len(merged) / (sample_rate_out or 24000):.2f}")
    print(f"case_start={case_start:.2f}")
    print(f"dashboard_start={dashboard_start:.2f}")


if __name__ == "__main__":
    main()
