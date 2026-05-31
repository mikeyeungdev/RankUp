require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;
const uploadDir = path.join(__dirname, "uploads");
const audioDir = path.join(__dirname, "processed-audio");
const transcribeProvider = process.env.TRANSCRIBE_PROVIDER || "local";
const analysisProvider = process.env.ANALYSIS_PROVIDER || "local_grounded";

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });
ffmpeg.setFfmpegPath(ffmpegPath);

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 1024 * 1024 * 500 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) {
      cb(new Error("Please upload a video file."));
      return;
    }

    cb(null, true);
  },
});

app.use(express.static(__dirname));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    transcribeProvider,
    analysisProvider,
    localWhisperModel: process.env.LOCAL_WHISPER_MODEL || "base",
    ollamaHost: process.env.OLLAMA_HOST || "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
    transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
    analysisModel: process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1-mini",
  });
});

app.post("/api/reviews", upload.single("vod"), async (req, res) => {
  if ((transcribeProvider === "openai" || analysisProvider === "openai") && !process.env.OPENAI_API_KEY) {
    res.status(400).json({
      error:
        "Missing OPENAI_API_KEY. Add it to .env or switch TRANSCRIBE_PROVIDER to local and ANALYSIS_PROVIDER to local_grounded.",
    });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "No VOD file was uploaded." });
    return;
  }

  const uploadedPath = req.file.path;
  const audioPath = path.join(audioDir, `${req.file.filename}.mp3`);

  try {
    await extractAudio(uploadedPath, audioPath);
    const transcription = await transcribeAudio(audioPath);
    const transcriptText = normalizeTranscript(transcription);
    const segments = normalizeSegments(transcription, transcriptText);
    const analysis = await analyzeTranscript(transcriptText, req.file.originalname, segments);

    res.json({
      fileName: req.file.originalname,
      transcript: transcriptText,
      segments,
      analysis,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message || "Failed to process the coached VOD.",
    });
  } finally {
    cleanup(uploadedPath);
    cleanup(audioPath);
  }
});

app.use((error, _req, res, _next) => {
  res.status(400).json({ error: error.message || "Upload failed." });
});

const server = app.listen(port, () => {
  console.log(`RankUp running at http://localhost:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use. RankUp may already be running at http://localhost:${port}.`
    );
    console.error(`Stop the existing server or set PORT=${Number(port) + 1} in .env.`);
    process.exit(1);
  }

  throw error;
});

function extractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioBitrate("48k")
      .format("mp3")
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

async function transcribeAudio(audioPath) {
  if (transcribeProvider === "local") {
    return transcribeAudioLocally(audioPath);
  }

  const openai = getOpenAIClient();

  return openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
    response_format: "verbose_json",
    temperature: 0.2,
  });
}

async function analyzeTranscript(transcript, fileName, segments = []) {
  if (analysisProvider === "none") {
    return buildTranscriptOnlyResult(transcript, fileName);
  }

  if (analysisProvider === "local_grounded") {
    return buildGroundedTrainingPlan(transcript, fileName, segments);
  }

  if (analysisProvider === "ollama") {
    return analyzeTranscriptWithOllama(transcript, fileName, segments);
  }

  const openai = getOpenAIClient();
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "importantConcepts", "recurringMistakes", "trainingGoals"],
    properties: {
      summary: { type: "string" },
      importantConcepts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "category", "whyItMatters", "frequency"],
          properties: {
            name: { type: "string" },
            category: { type: "string" },
            whyItMatters: { type: "string" },
            frequency: { type: "number" },
          },
        },
      },
      recurringMistakes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["mistake", "evidence", "fix"],
          properties: {
            mistake: { type: "string" },
            evidence: { type: "string" },
            fix: { type: "string" },
          },
        },
      },
      trainingGoals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description", "targetConcept"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            targetConcept: { type: "string" },
          },
        },
      },
    },
  };

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "You are RankUp, a League of Legends VOD review assistant. Organize coach commentary into practical improvement plans. Focus on concepts like wave management, jungle tracking, vision, objective tempo, recall timing, teamfight positioning, and champion-specific execution.",
      },
      {
        role: "user",
        content: `Analyze this coached VOD transcript from ${fileName}.\n\n${transcript}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "rankup_review",
        strict: true,
        schema,
      },
    },
  });

  return JSON.parse(completion.choices[0].message.content);
}

async function analyzeTranscriptWithOllama(transcript, fileName, segments) {
  const cleanTranscript = transcript.trim();

  if (!cleanTranscript) {
    return buildTranscriptOnlyResult(transcript, fileName);
  }

  const ollamaHost = process.env.OLLAMA_HOST || "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL || "llama3.1:8b";
  const prompt = buildOllamaPrompt(fileName, cleanTranscript, segments);

  const response = await fetch(`${ollamaHost}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      format: "json",
      options: {
        temperature: 0.1,
        top_p: 0.8,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Ollama analysis failed. Make sure Ollama is running and ${model} is installed. ${text}`
    );
  }

  const payload = await response.json();

  try {
    return normalizeOllamaAnalysis(JSON.parse(payload.response), fileName, cleanTranscript);
  } catch (error) {
    throw new Error(`Ollama returned invalid JSON. ${error.message}`);
  }
}

function buildOllamaPrompt(fileName, transcript, segments) {
  const segmentText = segments
    .slice(0, 40)
    .map((segment) => `[${formatSeconds(segment.start)}] ${segment.text}`)
    .join("\n");

  return `
You are RankUp, a League of Legends coaching assistant.

Task:
Create a concise structured training plan from a coached VOD transcript.

Rules:
- Use ONLY the transcript.
- Do not invent events, champion details, mistakes, timestamps, or advice.
- Every concept, mistake, and training goal must include a short exact quote from the transcript as evidence.
- If the transcript does not support an item, omit it.
- Prefer specific coach instructions over generic advice.
- Keep the output useful for a student and coach to share after review.

Return ONLY valid JSON with this shape:
{
  "summary": "one concise paragraph",
  "importantConcepts": [
    {
      "name": "short label grounded in transcript",
      "category": "macro | positioning | objective_control | laning | vision | mechanics | review_note",
      "whyItMatters": "why this matters, tied to the quote",
      "frequency": 1,
      "evidence": "exact transcript quote"
    }
  ],
  "recurringMistakes": [
    {
      "mistake": "short mistake or review issue grounded in transcript",
      "evidence": "exact transcript quote",
      "fix": "specific action based only on transcript"
    }
  ],
  "trainingGoals": [
    {
      "title": "short practice goal",
      "description": "specific action based only on transcript",
      "targetConcept": "matching concept label",
      "evidence": "exact transcript quote"
    }
  ],
  "keyMoments": [
    {
      "time": 0,
      "text": "short exact or near-exact transcript moment",
      "topic": "short label"
    }
  ]
}

File: ${fileName}

Timestamped transcript segments:
${segmentText || "No timestamped segments available."}

Full transcript:
${transcript}
`.trim();
}

function normalizeOllamaAnalysis(analysis, fileName, transcript) {
  const summary =
    typeof analysis.summary === "string" && analysis.summary.trim()
      ? analysis.summary.trim()
      : `RankUp analyzed ${fileName} with Ollama. Review the transcript evidence before sharing.`;

  return {
    summary,
    importantConcepts: normalizeArray(analysis.importantConcepts).slice(0, 6).map((item, index) => ({
      name: safeString(item.name, `Concept ${index + 1}`),
      category: safeString(item.category, "review_note"),
      whyItMatters: withEvidence(item.whyItMatters, item.evidence),
      frequency: Number.isFinite(Number(item.frequency)) ? Number(item.frequency) : 20,
      evidence: safeString(item.evidence, ""),
    })),
    recurringMistakes: normalizeArray(analysis.recurringMistakes).slice(0, 5).map((item) => ({
      mistake: safeString(item.mistake, "Review issue"),
      evidence: safeString(item.evidence, ""),
      fix: safeString(item.fix, ""),
    })),
    trainingGoals: normalizeArray(analysis.trainingGoals).slice(0, 5).map((item, index) => ({
      title: safeString(item.title, `Goal ${index + 1}`),
      description: safeString(item.description, ""),
      targetConcept: safeString(item.targetConcept, "Review note"),
      evidence: safeString(item.evidence, ""),
    })),
    keyMoments: normalizeArray(analysis.keyMoments).slice(0, 8).map((item) => ({
      time: Number.isFinite(Number(item.time)) ? Number(item.time) : 0,
      text: safeString(item.text, ""),
      topic: safeString(item.topic, "Review moment"),
    })),
    metadata: {
      analysisMode: "ollama",
      wordCount: transcript.split(/\s+/).filter(Boolean).length,
    },
  };
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function withEvidence(text, evidence) {
  const cleanText = safeString(text, "");
  const cleanEvidence = safeString(evidence, "");

  if (!cleanEvidence) {
    return cleanText;
  }

  return cleanText.includes(cleanEvidence)
    ? cleanText
    : `${cleanText} Evidence: "${cleanEvidence}"`;
}

function formatSeconds(seconds) {
  const rounded = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(rounded / 60);
  const remainder = String(rounded % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function normalizeTranscript(transcription) {
  if (typeof transcription === "string") {
    return transcription;
  }

  return transcription.text || "";
}

function transcribeAudioLocally(audioPath) {
  const pythonCommand = process.env.PYTHON_COMMAND || "py";
  const model = process.env.LOCAL_WHISPER_MODEL || "base";
  const scriptPath = path.join(__dirname, "scripts", "local_transcribe.py");

  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, [scriptPath, audioPath, model], {
      cwd: __dirname,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `Could not start local Whisper with "${pythonCommand}". Set PYTHON_COMMAND in .env. ${error.message}`
        )
      );
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Local Whisper failed. Run "py -m pip install -r requirements.txt" and try again. ${stderr || stdout}`
          )
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Could not parse local Whisper output. ${error.message}`));
      }
    });
  });
}

function buildTranscriptOnlyResult(transcript, fileName) {
  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;

  return {
    summary: transcript.trim()
      ? `Transcript extracted for ${fileName}. Review notes are limited to direct transcript text.`
      : `Transcript generated for ${fileName}, but no clear coach speech was detected.`,
    importantConcepts: [],
    recurringMistakes: [],
    trainingGoals: [],
    metadata: {
      analysisMode: "transcript_only",
      wordCount,
    },
  };
}

function buildGroundedTrainingPlan(transcript, fileName, fallbackSegments) {
  const cleanTranscript = transcript.trim();
  const wordCount = cleanTranscript.split(/\s+/).filter(Boolean).length;

  if (wordCount < 25) {
    return {
      summary: `RankUp processed ${fileName}, but there was not enough coach commentary to extract reliable review notes.`,
      importantConcepts: [],
      recurringMistakes: [],
      trainingGoals: [],
      keyMoments: [],
      metadata: {
        analysisMode: "local_grounded",
        wordCount,
        confidence: "low",
      },
    };
  }

  const sentences = splitTranscriptIntoSentences(cleanTranscript);
  const excerptSentences = sentences
    .filter(isCoachingSentence)
    .slice(0, 6);
  const actionSentences = sentences
    .filter(isActionableSentence)
    .slice(0, 6);

  const importantConcepts = (excerptSentences.length > 0 ? excerptSentences : sentences.slice(0, 4)).map(
    (sentence, index) => ({
      name: `Coach excerpt ${index + 1}`,
      category: "transcript_excerpt",
      whyItMatters: sentence,
      frequency: 100 - index * 8,
    })
  );

  const trainingGoals = actionSentences.map((sentence, index) => ({
    title: `Action item ${index + 1}`,
    description: sentence,
    targetConcept: "Transcript action item",
    evidence: sentence,
  }));

  const keyMoments = fallbackSegments
    .filter((segment) => segment.text && segment.text.trim())
    .slice(0, 8)
    .map((segment) => ({
      time: segment.start,
      text: segment.text,
      topic: "Transcript moment",
    }));

  return {
    summary: `RankUp extracted shareable coach notes from ${fileName}. Items below are direct transcript excerpts.`,
    importantConcepts,
    recurringMistakes: [],
    trainingGoals,
    keyMoments,
    metadata: {
      analysisMode: "local_grounded",
      wordCount,
      confidence: "evidence_based",
    },
  };
}

function isCoachingSentence(sentence) {
  const lower = sentence.toLowerCase();
  return isActionableSentence(sentence) || [
    "because",
    "mistake",
    "problem",
    "good",
    "bad",
    "important",
    "watch",
    "notice",
    "look at",
    "this is",
    "that's why",
  ].some((phrase) => lower.includes(phrase));
}

function splitTranscriptIntoSentences(transcript) {
  return transcript
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12);
}

function isActionableSentence(sentence) {
  const lower = sentence.toLowerCase();
  return [
    "need to",
    "should",
    "don't",
    "do not",
    "remember",
    "try to",
    "focus",
    "make sure",
    "you have to",
    "you need",
    "stop",
    "start",
    "look",
  ].some((phrase) => lower.includes(phrase));
}

function normalizeSegmentsFromText(transcript) {
  return splitTranscriptIntoSentences(transcript).map((sentence, index) => ({
    start: index * 30,
    end: index * 30 + 15,
    text: sentence,
  }));
}

function normalizeSegments(transcription, transcriptText) {
  if (Array.isArray(transcription.segments) && transcription.segments.length > 0) {
    return transcription.segments.slice(0, 12).map((segment) => ({
      start: Math.round(segment.start || 0),
      end: Math.round(segment.end || 0),
      text: segment.text.trim(),
    }));
  }

  if (!transcriptText.trim()) {
    return [];
  }

  return [
    {
      start: 0,
      end: 0,
      text: transcriptText,
    },
  ];
}

function cleanup(filePath) {
  fs.rm(filePath, { force: true }, () => {});
}

function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}
