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
const analysisProvider = process.env.ANALYSIS_PROVIDER || "local";

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
    transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
    analysisModel: process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1-mini",
  });
});

app.post("/api/reviews", upload.single("vod"), async (req, res) => {
  if ((transcribeProvider === "openai" || analysisProvider === "openai") && !process.env.OPENAI_API_KEY) {
    res.status(400).json({
      error:
        "Missing OPENAI_API_KEY. Add it to .env or switch TRANSCRIBE_PROVIDER and ANALYSIS_PROVIDER to local.",
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
    const analysis = await analyzeTranscript(transcriptText, req.file.originalname);

    res.json({
      fileName: req.file.originalname,
      transcript: transcriptText,
      segments: normalizeSegments(transcription, transcriptText),
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

async function analyzeTranscript(transcript, fileName) {
  if (analysisProvider === "local") {
    return analyzeTranscriptLocally(transcript, fileName);
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

function analyzeTranscriptLocally(transcript, fileName) {
  if (transcript.trim().length < 40) {
    return {
      summary: `RankUp processed ${fileName}, but local Whisper found very little coach speech. The structured output below is a fallback template, not a reliable summary of the VOD.`,
      importantConcepts: [
        {
          name: "Transcript Quality",
          category: "audio",
          whyItMatters:
            "The analysis depends on the coach audio transcript. Low-volume audio, music, game sounds, or no spoken review will make the output generic.",
          frequency: 100,
        },
      ],
      recurringMistakes: [
        {
          mistake: "Not enough transcript evidence for mistake detection.",
          evidence: "Local Whisper returned too little spoken text.",
          fix: "Use a VOD with clear coach commentary audio or set LOCAL_WHISPER_MODEL=base for better transcription accuracy.",
        },
      ],
      trainingGoals: [
        {
          title: "Improve transcript input",
          description:
            "Upload a VOD where the coach commentary is louder than gameplay audio, then process it again.",
          targetConcept: "Transcript Quality",
        },
      ],
    };
  }

  const lowerTranscript = transcript.toLowerCase();
  const conceptRules = [
    {
      name: "Objective Tempo",
      category: "objective_control",
      keywords: ["dragon", "baron", "objective", "reset", "tempo", "spawn", "timer"],
      whyItMatters:
        "Neutral objectives are usually won before the fight starts through reset timing, river control, and first move.",
      goal: {
        title: "45-second objective setup",
        description:
          "Before each dragon or Baron, reset early, buy a control ward, push mid, and move with your jungler before the timer reaches 30 seconds.",
        targetConcept: "Objective Tempo",
      },
    },
    {
      name: "Wave Management",
      category: "laning",
      keywords: ["wave", "crash", "freeze", "slow push", "push", "lane", "minion"],
      whyItMatters:
        "Wave state decides whether you can recall, roam, contest vision, or move first to a fight.",
      goal: {
        title: "Wave into action",
        description:
          "After crashing a wave, immediately choose the next action: ward, reset, roam, or pressure objective setup.",
        targetConcept: "Wave Management",
      },
    },
    {
      name: "Jungle Tracking",
      category: "jungle_tracking",
      keywords: ["jungle", "jungler", "gank", "lee sin", "vi", "sejuani", "pathing", "raptor", "ward"],
      whyItMatters:
        "Knowing the enemy jungler's likely location changes which trades and river movements are safe.",
      goal: {
        title: "Jungler location callout",
        description:
          "Before every aggressive trade, say the enemy jungler's likely quadrant and whether your nearest ward is still active.",
        targetConcept: "Jungle Tracking",
      },
    },
    {
      name: "Vision Control",
      category: "vision",
      keywords: ["vision", "ward", "control ward", "sweeper", "fog", "river", "brush"],
      whyItMatters:
        "Vision turns coach advice into actionable safety checks before rotations and objective fights.",
      goal: {
        title: "Vision before face-checking",
        description:
          "Use trinket, sweeper, or teammate pressure before entering fog around river and jungle entrances.",
        targetConcept: "Vision Control",
      },
    },
    {
      name: "Teamfight Positioning",
      category: "teamfighting",
      keywords: ["fight", "position", "frontline", "backline", "flank", "charm", "engage", "teamfight"],
      whyItMatters:
        "Your champion's job changes by fight: threaten from fog, follow engage, peel, or hold cooldowns.",
      goal: {
        title: "Define fight job first",
        description:
          "Before a fight starts, identify whether your role is engage follow-up, pick threat, peel, or damage cleanup.",
        targetConcept: "Teamfight Positioning",
      },
    },
  ];

  const concepts = conceptRules
    .map((concept) => ({
      ...concept,
      frequency: countKeywordMatches(lowerTranscript, concept.keywords),
    }))
    .filter((concept) => concept.frequency > 0)
    .sort((a, b) => b.frequency - a.frequency);

  const selectedConcepts = concepts.length > 0 ? concepts.slice(0, 4) : conceptRules.slice(0, 3);
  const importantConcepts = selectedConcepts.map((concept) => ({
    name: concept.name,
    category: concept.category,
    whyItMatters: concept.whyItMatters,
    frequency: Math.min(100, Math.max(15, concept.frequency * 18 || 20)),
  }));

  const recurringMistakes = selectedConcepts.slice(0, 3).map((concept) => ({
    mistake: `${concept.name} is not being converted into a repeatable in-game routine.`,
    evidence: findEvidenceSentence(transcript, concept.keywords),
    fix: concept.goal.description,
  }));

  const trainingGoals = selectedConcepts.slice(0, 3).map((concept) => concept.goal);

  return {
    summary: buildLocalSummary(fileName, importantConcepts, transcript),
    importantConcepts,
    recurringMistakes,
    trainingGoals,
  };
}

function countKeywordMatches(text, keywords) {
  return keywords.reduce((total, keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = text.match(new RegExp(`\\b${escaped}\\b`, "g"));
    return total + (matches ? matches.length : 0);
  }, 0);
}

function findEvidenceSentence(transcript, keywords) {
  const sentences = transcript
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const match = sentences.find((sentence) =>
    keywords.some((keyword) => sentence.toLowerCase().includes(keyword))
  );

  return match || "The coach transcript references this concept during the review.";
}

function buildLocalSummary(fileName, concepts, transcript) {
  if (!transcript.trim()) {
    return `RankUp processed ${fileName}, but the local transcription did not detect clear coach speech. Try a VOD with louder commentary audio or a larger Whisper model.`;
  }

  const names = concepts.map((concept) => concept.name).join(", ");
  return `RankUp processed ${fileName} locally using the transcript text. The keyword-based analysis found the strongest coaching themes around ${names}. Check the raw transcript below to confirm whether the detected themes match what was actually said.`;
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
