import json
import sys
from pathlib import Path

from faster_whisper import WhisperModel


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing audio path"}))
        sys.exit(1)

    audio_path = Path(sys.argv[1])
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"

    if not audio_path.exists():
        print(json.dumps({"error": f"Audio file not found: {audio_path}"}))
        sys.exit(1)

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(audio_path),
        beam_size=5,
        vad_filter=True,
        word_timestamps=False,
    )

    normalized_segments = []
    text_parts = []

    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue

        normalized_segments.append(
            {
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": text,
            }
        )
        text_parts.append(text)

    print(
        json.dumps(
            {
                "text": " ".join(text_parts),
                "language": info.language,
                "duration": info.duration,
                "segments": normalized_segments,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
