# RankUp

RankUp is a portfolio-style League of Legends coaching assistant that turns coached VOD audio into evidence-backed training plans.

The app uploads a coached VOD, extracts audio, transcribes coach commentary locally, and can use Ollama to organize the transcript into focus areas, key moments, and training goals. Generated items are required to include transcript evidence so coaches and students can verify the output.

## Features

- Coached VOD upload workflow
- Local audio extraction with FFmpeg
- Local transcription with faster-whisper
- Optional local Ollama analysis for structured training plans
- Timestamped transcript segments and full transcript copy view
- PostgreSQL schema for future review history, goals, and trend tracking

## Run The App

```powershell
npm install
Copy-Item .env.example .env
npm run setup:local-whisper
npm run dev
```

Open:

```text
http://localhost:3000
```

## Free Local AI Setup

Install Ollama, then pull a model:

```powershell
ollama pull llama3.1:8b
```

Use these `.env` settings:

```env
TRANSCRIBE_PROVIDER=local
ANALYSIS_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
LOCAL_WHISPER_MODEL=tiny
PYTHON_COMMAND=py
PORT=3000
```

If Ollama is not installed or running, switch back to extraction-only mode:

```env
ANALYSIS_PROVIDER=local_grounded
```

## Workflow

```text
Upload coached VOD
-> Extract coach audio
-> Transcribe commentary with timestamps
-> Generate evidence-backed training plan with Ollama
-> Verify against the raw transcript
```

## Implementation

- Express backend
- Multer VOD uploads
- FFmpeg audio extraction
- faster-whisper local transcription
- Ollama local LLM analysis
- Static HTML, CSS, and JavaScript UI
