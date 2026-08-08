import json
from pathlib import Path

import numpy as np
import soundfile as sf


BASE = Path(__file__).resolve().parent
SEGMENT_DIR = BASE / "voicebox_v3"
PAUSE_SECONDS = 0.24
SKIPPED_SEGMENTS = {6}
CASE_HOLD_SECONDS = 68.0
CASE_TIMED_OFFSETS = {
    10: 0.0,
    11: 3.0,
    12: 18.5,
    13: 30.5,
    14: 50.0,
    15: 59.0,
}


def ass_time(seconds: float) -> str:
    cs = int(round(seconds * 100))
    h = cs // 360000
    cs %= 360000
    m = cs // 6000
    cs %= 6000
    s = cs // 100
    cs %= 100
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def wrap_ass(text: str, width: int = 23) -> str:
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
Style: Default, Microsoft YaHei, 47, &H00FFFFFF, &H00FFFFFF, &HFF000000, &H90404040, 0, 0, 0, 0, 100, 100, 0, 0, 4, 14, 0, 2, 120, 120, 56, 1

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
    lines = [
        line.strip()
        for line in (BASE / "narration_v3.txt").read_text(encoding="utf-8-sig").splitlines()
        if line.strip()
    ]

    pieces = []
    events = []
    cursor = 0.0
    sample_rate_out = None
    case_start = None
    dashboard_start = None

    for index, text in enumerate(lines, 1):
        if index in SKIPPED_SEGMENTS:
            continue

        if index == 10:
            case_start = cursor

        if 10 <= index <= 15 and case_start is not None:
            target_start = case_start + CASE_TIMED_OFFSETS[index]
            if cursor < target_start:
                if sample_rate_out is None:
                    sample_rate_out = 24000
                gap = target_start - cursor
                pieces.append(np.zeros(int(sample_rate_out * gap), dtype=np.float32))
                cursor = target_start

        if index == 16 and case_start is not None:
            desired_dashboard_start = case_start + CASE_HOLD_SECONDS
            if cursor < desired_dashboard_start:
                if sample_rate_out is None:
                    sample_rate_out = 24000
                gap = desired_dashboard_start - cursor
                pieces.append(np.zeros(int(sample_rate_out * gap), dtype=np.float32))
                cursor = desired_dashboard_start
            dashboard_start = cursor

        path = SEGMENT_DIR / f"segment_{index:02d}.wav"
        audio, sample_rate = read_audio(path)
        if sample_rate_out is None:
            sample_rate_out = sample_rate
        if sample_rate != sample_rate_out:
            raise ValueError(f"mixed sample rates: {path} has {sample_rate}, expected {sample_rate_out}")

        duration = len(audio) / sample_rate
        phase = "main"
        if 10 <= index <= 15:
            phase = "case"
        elif index >= 16:
            phase = "dashboard"
        events.append({"start": cursor, "end": cursor + duration + 0.1, "text": text, "phase": phase})
        pieces.append(audio)
        pieces.append(np.zeros(int(sample_rate * PAUSE_SECONDS), dtype=np.float32))
        cursor += duration + PAUSE_SECONDS

    merged = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)
    sf.write(BASE / "voicebox_narration_v3_final.wav", merged, sample_rate_out or 24000)
    write_ass(BASE / "subtitles_v3.ass", events)
    meta = {
        "duration": len(merged) / (sample_rate_out or 24000),
        "case_start": case_start,
        "dashboard_start": dashboard_start,
        "case_duration": (dashboard_start - case_start) if case_start is not None and dashboard_start is not None else None,
        "events": events,
    }
    (BASE / "timeline_v3.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in meta.items() if k != "events"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
