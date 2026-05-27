# RankUp

RankUp is a portfolio-style League of Legends coaching assistant that turns coached VOD audio into structured improvement plans.

Instead of trying to fully understand raw gameplay from a replay file, RankUp focuses on a more realistic and useful workflow: the player uploads a VOD that already contains coach review commentary, then the app transcribes that commentary, detects key timestamps, organizes the concepts being taught, and generates training goals.

## Demo Scope

- Coached VOD upload workflow
- Audio extraction and speech-to-text pipeline mockup
- Timestamped transcript moments from coach commentary
- League concept classification for wave management, jungle tracking, objective tempo, and positioning
- AI-generated coaching summary, repeated themes, and action plan
- PostgreSQL schema for storing VODs, transcripts, concepts, reports, and goals

## Run The App

Install dependencies:

```powershell
npm install
```

Create a `.env` file:

```powershell
Copy-Item .env.example .env
```

For the free local mode, keep these settings in `.env`:

```text
TRANSCRIBE_PROVIDER=local
ANALYSIS_PROVIDER=local
LOCAL_WHISPER_MODEL=tiny
PYTHON_COMMAND=py
```

Install local Whisper support:

```powershell
npm run setup:local-whisper
```

Start the server:

```powershell
npm run dev
```

Open:

```text
http://localhost:3000
```

Drag a video onto the upload area, or click it to choose a local VOD. The app previews the selected video, uploads it to the local server, extracts audio with FFmpeg, transcribes the coach commentary with local Whisper, and generates structured League coaching feedback locally.

The first local transcription may take longer because Whisper downloads the selected model. `tiny` is fastest for demos; change `LOCAL_WHISPER_MODEL` to `base` for better accuracy.

## Provider Options

Free local mode:

```env
TRANSCRIBE_PROVIDER=local
ANALYSIS_PROVIDER=local
LOCAL_WHISPER_MODEL=tiny
PYTHON_COMMAND=py
```

Optional OpenAI mode:

```env
OPENAI_API_KEY=your_openai_api_key_here
TRANSCRIBE_PROVIDER=openai
ANALYSIS_PROVIDER=openai
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_ANALYSIS_MODEL=gpt-4.1-mini
```

Hybrid mode:

```env
TRANSCRIBE_PROVIDER=local
ANALYSIS_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key_here
```

## Product Workflow

```text
Upload coached VOD
-> Extract coach audio
-> Transcribe commentary with timestamps
-> Classify League concepts
-> Generate AI summary and goals
-> Track improvement trends over time
```

## Implementation

The current implementation uses:

- Express for the local backend
- Multer for VOD uploads
- FFmpeg for extracting compressed MP3 audio from uploaded videos
- faster-whisper for free local coach commentary transcription
- Local keyword/concept analysis for free League coaching summaries
- Optional OpenAI transcription and structured JSON output
- Static HTML, CSS, and JavaScript for the portfolio UI

A production version could add PostgreSQL persistence, authentication, cloud object storage, background jobs for long VODs, and saved review history.

## OpenAI Workflow

1. Player uploads a VOD that includes coach review audio.
2. Backend extracts the audio track from the video.
3. Speech-to-text creates timestamped transcript segments.
4. Text model classifies each segment into League concepts.
5. Model returns a summary, recurring concepts, mistakes, and weekly training goals.
6. The dashboard tracks which concepts appear most often across reviews.

Example prompt shape:

```text
You are a League of Legends VOD review assistant.
Analyze this coach transcript.
Return:
- concise review summary
- important League concepts discussed
- recurring player mistakes
- timestamped teachable moments
- three concrete training goals
```

## Project Pitch

RankUp demonstrates full-stack product thinking around a realistic AI workflow: media upload, transcription, natural language classification, structured data modeling, and player improvement analytics. The project avoids fragile replay parsing while still solving a real coaching problem.
