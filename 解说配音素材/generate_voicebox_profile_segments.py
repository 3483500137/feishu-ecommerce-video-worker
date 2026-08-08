import asyncio
import sqlite3
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

VOICEBOX_SRC = Path(r"C:\Users\linzhiying\.codex\vendor_imports\voicebox")
VOICEBOX_DATA = Path(r"C:\Users\linzhiying\AppData\Roaming\sh.voicebox.app")
PROFILE_NAME = "林芷莹-基础-中声v2"
PROFILE_ID = "426ab159-709a-4624-bc75-f66e20bf9ec3"
MODEL_SIZE = "1.7B"
INSTRUCT = "自然、有节奏、有情绪起伏，像在给客户讲真实产品演示；语速清晰稍快，重点词稍作停顿。"

sys.path.insert(0, str(VOICEBOX_SRC))

from backend import config
from backend.backends.pytorch_backend import PyTorchTTSBackend
from backend.utils.audio import normalize_audio, save_audio


def load_profile_sample() -> tuple[Path, str]:
    db_path = VOICEBOX_DATA / "voicebox.db"
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    row = con.execute(
        "select audio_path, reference_text from profile_samples where profile_id = ? order by id limit 1",
        (PROFILE_ID,),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"Voicebox profile sample not found: {PROFILE_NAME}")
    return VOICEBOX_DATA / row["audio_path"], row["reference_text"]


async def main() -> None:
    base = Path(__file__).resolve().parent
    script_path = base / "narration_v3.txt"
    out_dir = base / "voicebox_v3"
    out_dir.mkdir(parents=True, exist_ok=True)

    config.set_data_dir(VOICEBOX_DATA)
    reference_audio, reference_text = load_profile_sample()
    chunks = [line.strip() for line in script_path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]

    backend = PyTorchTTSBackend(model_size=MODEL_SIZE)
    backend.model_size = MODEL_SIZE
    voice_prompt, cached = await backend.create_voice_prompt(str(reference_audio), reference_text, use_cache=True)
    print(f"profile={PROFILE_NAME} model={MODEL_SIZE} cached_prompt={cached}", flush=True)

    for index, text in enumerate(chunks, 1):
        out_path = out_dir / f"segment_{index:02d}.wav"
        if out_path.exists() and out_path.stat().st_size > 44:
            print(f"skip segment {index:02d}", flush=True)
            continue
        print(f"generate segment {index:02d}/{len(chunks)}: {text[:28]}", flush=True)
        audio, sample_rate = await backend.generate(
            text=text,
            voice_prompt=voice_prompt,
            language="zh",
            seed=2026072700 + index,
            instruct=INSTRUCT,
        )
        audio = normalize_audio(audio, target_db=-18.5, peak_limit=0.9)
        save_audio(audio.astype(np.float32), str(out_path), sample_rate)

    backend.unload_model()
    print(out_dir, flush=True)


if __name__ == "__main__":
    asyncio.run(main())
