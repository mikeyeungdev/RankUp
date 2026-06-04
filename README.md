# RankUp

RankUp is a portfolio-style League of Legends coaching assistant that turns coached VOD audio into evidence-backed training plans.

The app uploads a coached VOD, extracts audio, transcribes coach commentary locally, and can use Ollama to organize the transcript into focus areas, key moments, and training goals. Generated items are required to include transcript evidence so coaches and students can verify the output.

## Features

- Coached VOD upload workflow
- Local audio extraction with FFmpeg
- Local transcription with faster-whisper
- Optional local Ollama analysis for structured training plans
- Markdown coaching knowledge base for better League-specific structure
- Timestamped transcript segments and full transcript copy view
- PostgreSQL schema for future review history, goals, and trend tracking

## Prerequisites

Install these before running RankUp:

- Node.js
- Python
- Ollama desktop app

RankUp uses local Whisper for transcription and Ollama for free local analysis. The page must be opened from the running Express server, not by double-clicking `index.html`.

## First-Time Setup

```powershell
npm install
Copy-Item .env.example .env
npm run setup:local-whisper
ollama pull llama3.1:8b
```

Open the Ollama desktop app before using the analyzer. If Ollama is running correctly, this URL should respond:

```text
http://localhost:11434
```

Recommended `.env` settings:

```env
TRANSCRIBE_PROVIDER=local
ANALYSIS_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
LOCAL_WHISPER_MODEL=tiny
PYTHON_COMMAND=py
PORT=3000
MAX_SAVED_REVIEWS=5
KNOWLEDGE_TOP_K=3
KNOWLEDGE_MAX_CHARS=900
OLLAMA_TIMEOUT_MS=120000
OLLAMA_TRANSCRIPT_MAX_CHARS=9000
```

## Run The App

```powershell
npm run dev
```

Open:

```text
http://localhost:3000
```

## How To Analyze A VOD

1. Open the Ollama desktop app.
2. Start RankUp with `npm run dev`.
3. Open `http://localhost:3000`.
4. Choose or drag in a coached League of Legends VOD.
5. Click `Analyze VOD`.
6. Wait for the loading states:
   - Extracting audio
   - Transcribing coach audio
   - Retrieving coaching fundamentals
   - Building training plan
7. Review the generated notes and compare them against the transcript.
8. Use `Full Transcript` to inspect the raw transcript.
9. Use `Copy Transcript` if you want to save or share the transcript.

The best input is a VOD that already contains spoken coach review audio. RankUp is designed around coach commentary, not silent gameplay.

## Output Sections

RankUp produces:

- Summary: the main lesson from the coached VOD
- Review sections: transcript-backed themes from the video
- Focus areas: organized concepts such as macro, positioning, objective control, vision, jungle pathing, or wave management
- Training goals: concrete next-game actions
- Practice drills: repeatable exercises when the transcript supports them
- Key moments: timestamped transcript excerpts
- Full transcript: raw speech-to-text output for verification

Every generated coaching item should include transcript evidence. If something looks wrong, check the transcript first; poor audio can cause poor analysis.

## Review History Dashboard

Open the dashboard at:

```text
http://localhost:3000/dashboard.html
```

The dashboard tracks review history across analyzed VODs:

- total reviews
- completed reviews
- Ollama-assisted reviews
- top focus areas
- editable recommended training goals
- recent review summaries
- previous VOD analysis details

RankUp can run the dashboard from local JSON files, but PostgreSQL unlocks the full persistence story for a portfolio demo.

## PostgreSQL Setup

Create a local database:

```powershell
createdb rankup
```

Add this to `.env`:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/rankup
```

Then start the app:

```powershell
npm run dev
```

RankUp automatically creates the dashboard tables when the database is configured. You can also run the schema manually:

```powershell
psql "postgres://postgres:postgres@localhost:5432/rankup" -f database/schema.sql
```

If `DATABASE_URL` is missing or PostgreSQL is unavailable, RankUp falls back to the existing JSON files in `reviews/`.

## Saved Reviews

RankUp saves recent review outputs in `reviews/`.

- `Load Latest` loads the newest saved result.
- `Clear Saved` deletes saved review JSON files.
- `MAX_SAVED_REVIEWS` controls how many completed reviews are kept.

The `reviews/`, `uploads/`, and `processed-audio/` folders are local runtime data and should not be committed.

## Fallback Modes

If Ollama is slow, returns empty JSON, or returns malformed JSON, RankUp falls back to transcript-grounded extraction. You will still get direct coach excerpts and action items, but the result may be less structured than full Ollama analysis.

To skip Ollama entirely:

```env
ANALYSIS_PROVIDER=local_grounded
```

This mode is faster and free, but it produces simpler notes.

## Troubleshooting

If the page loads forever:

Refresh `http://localhost:3000`, then restart the server if needed:

```powershell
npm run dev
```

Make sure Ollama is open and the model exists:

```powershell
ollama pull llama3.1:8b
```

If transcription fails with `No module named 'faster_whisper'`:

```powershell
npm run setup:local-whisper
```

If Python still cannot import `faster_whisper`, check which Python `py` is using:

```powershell
py -c "import sys; print(sys.executable)"
py -c "from faster_whisper import WhisperModel; print('ok')"
```

If port `3000` is already in use:

```powershell
npm run stop
npm run dev
```

If the analysis is weak:

- Check `Full Transcript` for transcription quality.
- Use a VOD with clear coach audio.
- Keep Ollama running during analysis.
- Try a shorter VOD segment.
- Increase `LOCAL_WHISPER_MODEL` from `tiny` to `base` for better transcription accuracy.

## Workflow

```text
Upload coached VOD
-> Extract coach audio
-> Transcribe commentary with timestamps
-> Generate evidence-backed training plan with Ollama
-> Verify against the raw transcript
```

## Coaching Knowledge Base

RankUp includes a lightweight local knowledge base in `knowledge/`. Each markdown file contains coaching concepts the analyzer can use as supporting context.

The transcript is still the source of truth. The app retrieves the most relevant notes for each upload, passes them to Ollama, and instructs the model to use them only when the transcript already mentions that topic.

To add more expertise, create another `.md` file in `knowledge/`:

```text
knowledge/wave-management.md
knowledge/support-roaming.md
knowledge/adc-teamfighting.md
```

Keep each file practical: define the concept, list decision rules, and include drill ideas. Short focused notes usually work better than huge documents.

## Implementation

- Express backend
- Multer VOD uploads
- FFmpeg audio extraction
- faster-whisper local transcription
- Ollama local LLM analysis
- Local markdown retrieval for League coaching notes
- PostgreSQL-backed review history dashboard with JSON fallback
- Static HTML, CSS, and JavaScript UI
