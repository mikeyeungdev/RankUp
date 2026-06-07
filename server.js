require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const OpenAI = require("openai");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;
const databaseUrl = process.env.DATABASE_URL || "";
const uploadDir = path.join(__dirname, "uploads");
const audioDir = path.join(__dirname, "processed-audio");
const reviewDir = path.join(__dirname, "reviews");
const knowledgeDir = path.join(__dirname, "knowledge");
const maxSavedReviews = Number(process.env.MAX_SAVED_REVIEWS || 5);
const knowledgeTopK = Number(process.env.KNOWLEDGE_TOP_K || 3);
const knowledgeMaxChars = Number(process.env.KNOWLEDGE_MAX_CHARS || 900);
const ollamaTimeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 120000);
const ollamaTranscriptMaxChars = Number(process.env.OLLAMA_TRANSCRIPT_MAX_CHARS || 9000);
const transcribeProvider = process.env.TRANSCRIBE_PROVIDER || "local";
const analysisProvider = process.env.ANALYSIS_PROVIDER || "local_grounded";
const db = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });
fs.mkdirSync(reviewDir, { recursive: true });
fs.mkdirSync(knowledgeDir, { recursive: true });
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

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    transcribeProvider,
    analysisProvider,
    hasDatabase: Boolean(db),
    localWhisperModel: process.env.LOCAL_WHISPER_MODEL || "base",
    ollamaHost: process.env.OLLAMA_HOST || "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
    maxSavedReviews,
    knowledgeDocuments: listKnowledgeDocuments().length,
    knowledgeTopK,
    ollamaTimeoutMs,
    ollamaTranscriptMaxChars,
    transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
    analysisModel: process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1-mini",
  });
});

app.get("/api/knowledge", (_req, res) => {
  res.json(
    listKnowledgeDocuments().map(({ content, ...document }) => ({
      ...document,
      characterCount: content.length,
    }))
  );
});

app.get("/api/reviews", async (_req, res) => {
  res.json(await listReviewSummaries());
});

app.get("/api/reviews/latest", async (_req, res) => {
  const latest = await getLatestReview();

  if (!latest) {
    res.status(404).json({ error: "No saved reviews yet." });
    return;
  }

  res.json(latest);
});

app.get("/api/reviews/:id", async (req, res) => {
  const review = await getReviewById(req.params.id);

  if (!review) {
    res.status(404).json({ error: "Review not found." });
    return;
  }

  res.json(review);
});

app.delete("/api/reviews", (_req, res) => {
  const deleted = clearSavedReviews();
  res.json({ deleted });
});

app.get("/api/dashboard", async (_req, res) => {
  res.json(await getDashboardSummary());
});

app.patch("/api/goals/:id", async (req, res) => {
  if (!db) {
    res.status(503).json({ error: "PostgreSQL is not configured. Goal edits are available when DATABASE_URL is set." });
    return;
  }

  const status = String(req.body.status || "active").toLowerCase();
  const coachNote = String(req.body.coachNote || req.body.coach_note || "").trim();
  const allowedStatuses = new Set(["active", "completed", "paused"]);

  if (!allowedStatuses.has(status)) {
    res.status(400).json({ error: "Goal status must be active, completed, or paused." });
    return;
  }

  try {
    const updatedGoal = await updateDatabaseGoal(req.params.id, { status, coachNote });

    if (!updatedGoal) {
      res.status(404).json({ error: "Goal not found." });
      return;
    }

    res.json(updatedGoal);
  } catch (error) {
    console.error(`Goal update failed: ${error.message}`);
    res.status(500).json({ error: "Could not save goal edit." });
  }
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
  const timing = createProcessingTimer();

  try {
    const extractDone = timing.startStage("audioExtractionMs");
    await extractAudio(uploadedPath, audioPath);
    extractDone();

    const transcribeDone = timing.startStage("transcriptionMs");
    const transcription = await transcribeAudio(audioPath);
    transcribeDone();

    const transcriptText = normalizeTranscript(transcription);
    const segments = normalizeSegments(transcription, transcriptText);

    const analysisDone = timing.startStage("analysisMs");
    const analysis = await analyzeTranscript(transcriptText, req.file.originalname, segments);
    analysisDone();

    const review = {
      id: createReviewId(),
      createdAt: new Date().toISOString(),
      status: "completed",
      fileName: req.file.originalname,
      providers: {
        transcribeProvider,
        analysisProvider,
        localWhisperModel: process.env.LOCAL_WHISPER_MODEL || "base",
        ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
      },
      transcript: transcriptText,
      segments,
      analysis,
      processing: timing.finish(),
    };

    await saveReview(review);
    res.json(review);
  } catch (error) {
    console.error(error);
    await saveReview({
      id: createReviewId(),
      createdAt: new Date().toISOString(),
      status: "failed",
      fileName: req.file.originalname,
      providers: {
        transcribeProvider,
        analysisProvider,
        localWhisperModel: process.env.LOCAL_WHISPER_MODEL || "base",
        ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
      },
      processing: timing.finish(),
      error: error.message || "Failed to process the coached VOD.",
    });
    res.status(500).json({
      error: error.message || "Failed to process the coached VOD.",
    });
  } finally {
    cleanup(uploadedPath);
    cleanup(audioPath);
  }
});

startServer();

async function startServer() {
  await configureFrontend();

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
}

async function configureFrontend() {
  if (process.env.NODE_ENV === "production") {
    const distDir = path.join(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
    return;
  }

  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

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
          "You are RankUp, a League of Legends VOD review assistant. Organize coach commentary into practical improvement plans. Use the transcript to choose the relevant role, topic, and coaching concepts instead of forcing preset categories.",
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
  const knowledgeMatches = retrieveKnowledgeDocuments(cleanTranscript);
  const prompt = buildOllamaPrompt(fileName, cleanTranscript, segments, knowledgeMatches);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ollamaTimeoutMs);

  let response;

  try {
    response = await fetch(`${ollamaHost}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt,
        stream: true,
        format: "json",
        options: {
          temperature: 0.1,
        top_p: 0.8,
          num_ctx: 4096,
          num_predict: 1100,
      },
      }),
    });
  } catch (error) {
    clearTimeout(timeout);

    if (error.name === "AbortError") {
      return buildOllamaTimeoutFallback(cleanTranscript, fileName, segments, knowledgeMatches);
    }

    throw new Error(
      `Could not connect to Ollama at ${ollamaHost}. Make sure Ollama is running and ${model} is installed. ${error.message}`
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Ollama analysis failed. Make sure Ollama is running and ${model} is installed. ${text}`
    );
  }

  let generatedText = "";

  try {
    generatedText = await readOllamaStream(response);
  } catch (error) {
    clearTimeout(timeout);

    if (error.name === "AbortError") {
      return buildOllamaTimeoutFallback(cleanTranscript, fileName, segments, knowledgeMatches);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  let parsedAnalysis;

  try {
    parsedAnalysis = JSON.parse(generatedText);
  } catch (error) {
    return buildOllamaFallbackAnalysis(
      cleanTranscript,
      fileName,
      segments,
      knowledgeMatches,
      "ollama_invalid_json_local_grounded",
      `Ollama returned incomplete JSON for ${fileName}, so RankUp used transcript-grounded extraction instead.`,
      error.message
    );
  }

  const normalizedAnalysis = normalizeOllamaAnalysis(
    parsedAnalysis,
    fileName,
    cleanTranscript,
    knowledgeMatches
  );
  const validatedAnalysis = validateAnalysisEvidence(normalizedAnalysis, cleanTranscript);

  if (!hasStructuredAnalysis(validatedAnalysis)) {
    return buildOllamaFallbackAnalysis(
      cleanTranscript,
      fileName,
      segments,
      knowledgeMatches,
      "ollama_fallback_local_grounded",
      `Ollama returned an empty structured analysis for ${fileName}, so RankUp used transcript-grounded extraction instead.`,
      "Ollama returned no structured notes."
    );
  }

  return enrichOllamaAnalysisWithGroundedPlan(
    validatedAnalysis,
    buildGroundedTrainingPlan(cleanTranscript, fileName, segments)
  );
}

function buildOllamaTimeoutFallback(transcript, fileName, segments, knowledgeMatches) {
  return buildOllamaFallbackAnalysis(
    transcript,
    fileName,
    segments,
    knowledgeMatches,
    "ollama_timeout_local_grounded",
    `Ollama took longer than ${Math.round(
      ollamaTimeoutMs / 1000
    )} seconds for ${fileName}, so RankUp used transcript-grounded extraction instead.`,
    "Ollama timed out."
  );
}

function buildOllamaFallbackAnalysis(
  transcript,
  fileName,
  segments,
  knowledgeMatches,
  analysisMode,
  summary,
  fallbackReason
) {
  const fallbackAnalysis = buildGroundedTrainingPlan(transcript, fileName, segments);
  fallbackAnalysis.summary = summary;
  fallbackAnalysis.metadata = {
    ...fallbackAnalysis.metadata,
    analysisMode,
    fallbackReason,
    knowledgeSources: knowledgeMatches.map(({ file, title, score }) => ({ file, title, score })),
  };
  return fallbackAnalysis;
}

async function readOllamaStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let generatedText = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    lines.filter(Boolean).forEach((line) => {
      const payload = JSON.parse(line);
      generatedText += payload.response || "";
    });
  }

  if (buffer.trim()) {
    const payload = JSON.parse(buffer);
    generatedText += payload.response || "";
  }

  return generatedText.trim();
}

function buildOllamaPrompt(fileName, transcript, segments, knowledgeMatches = []) {
  const segmentText = segments
    .slice(0, 55)
    .map((segment) => `[${formatSeconds(segment.start)}] ${segment.text}`)
    .join("\n");
  const knowledgeContext = formatKnowledgeContext(knowledgeMatches);
  const clippedTranscript = clipText(transcript, ollamaTranscriptMaxChars);
  const contextSummary = formatTranscriptContext(inferTranscriptContext(transcript));

  return `
You are RankUp, a League of Legends coaching assistant.

Task:
Create a concise structured training plan from a coached VOD transcript.

Rules:
- Use the transcript as the source of truth.
- Use the coaching notes only to understand League concepts and organize topics that are already present in the transcript.
- Do not introduce advice from the coaching notes unless the transcript clearly mentions that topic.
- Do not invent events, champion details, mistakes, timestamps, or advice.
- Every concept, mistake, and training goal must include a short exact quote from the transcript as evidence.
- If the transcript does not support an item, omit it.
- Prefer specific coach instructions over generic advice.
- Extract the main sections of the coaching video when obvious.
- For transcripts over 200 words, produce only the concepts and goals that are strongly supported by transcript quotes.
- Prefer 2-5 importantConcepts and 2-5 concrete trainingGoals over filling weak categories.
- Include 3-8 keyMoments using timestamps from the timestamped segments when possible.
- Include 2-5 drills when mechanics, clears, warding, or decision routines are discussed.
- Use timestamps from the timestamped segments when possible.
- Keep the output useful for a student and coach to share after review.
- Only use role-specific labels such as jungle pathing, gank setup, champion identity, or enemy threat tracking when the transcript explicitly discusses that role or concept.
- If the transcript discusses a different role or topic, preserve that topic instead of forcing jungle categories.

Return ONLY valid JSON with this shape:
{
  "summary": "one concise paragraph",
  "reviewSections": [
    {
      "title": "section name from transcript, e.g. Runes or Clear Paths",
      "takeaway": "short takeaway grounded in transcript",
      "evidence": "exact transcript quote"
    }
  ],
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
  "drills": [
    {
      "name": "short drill name",
      "steps": ["specific step 1", "specific step 2"],
      "evidence": "exact transcript quote"
    }
  ],
  "keyMoments": [
    {
      "time": 0,
      "text": "short exact or near-exact transcript moment",
      "topic": "short label"
    }
  ],
  "confidence": "low | medium | high"
}

File: ${fileName}

Detected transcript context:
${contextSummary}

Relevant coaching notes:
${knowledgeContext || "No relevant coaching notes found."}

Timestamped transcript segments:
${segmentText || "No timestamped segments available."}

Full transcript:
${clippedTranscript}
`.trim();
}

function normalizeOllamaAnalysis(analysis, fileName, transcript, knowledgeMatches = []) {
  const summary =
    typeof analysis.summary === "string" && analysis.summary.trim()
      ? analysis.summary.trim()
      : `RankUp analyzed ${fileName} with Ollama. Review the transcript evidence before sharing.`;

  const reviewSections = normalizeArray(analysis.reviewSections).slice(0, 8).map((item, index) => ({
    title: safeString(item.title, `Section ${index + 1}`),
    takeaway: safeString(item.takeaway, ""),
    evidence: safeString(item.evidence, ""),
  }));
  const importantConcepts = normalizeArray(analysis.importantConcepts).slice(0, 6).map((item, index) => ({
    name: safeString(item.name, `Concept ${index + 1}`),
    category: safeString(item.category, "review_note"),
    whyItMatters: withEvidence(item.whyItMatters, item.evidence),
    frequency: Number.isFinite(Number(item.frequency)) ? Number(item.frequency) : 20,
    evidence: safeString(item.evidence, ""),
  }));
  const trainingGoals = normalizeArray(analysis.trainingGoals).slice(0, 6).map((item, index) => ({
    title: safeString(item.title, `Goal ${index + 1}`),
    description: safeString(item.description, ""),
    targetConcept: safeString(item.targetConcept, "Review note"),
    evidence: safeString(item.evidence, ""),
  }));
  const drills = normalizeArray(analysis.drills).slice(0, 5).map((item, index) => ({
    name: safeString(item.name, `Drill ${index + 1}`),
    steps: normalizeArray(item.steps).map((step) => safeString(step, "")).filter(Boolean).slice(0, 5),
    evidence: safeString(item.evidence, ""),
  }));

  return {
    summary,
    reviewSections,
    importantConcepts,
    recurringMistakes: normalizeArray(analysis.recurringMistakes).slice(0, 5).map((item) => ({
      mistake: safeString(item.mistake, "Review issue"),
      evidence: safeString(item.evidence, ""),
      fix: safeString(item.fix, ""),
    })),
    trainingGoals,
    drills,
    keyMoments: normalizeArray(analysis.keyMoments).slice(0, 8).map((item) => ({
      time: Number.isFinite(Number(item.time)) ? Number(item.time) : 0,
      text: safeString(item.text, ""),
      topic: safeString(item.topic, "Review moment"),
    })),
    metadata: {
      analysisMode: "ollama",
      wordCount: transcript.split(/\s+/).filter(Boolean).length,
      confidence: safeString(analysis.confidence, "medium"),
      knowledgeSources: knowledgeMatches.map(({ file, title, score }) => ({ file, title, score })),
    },
  };
}

function enrichOllamaAnalysisWithGroundedPlan(analysis, groundedPlan) {
  const enriched = {
    ...analysis,
    reviewSections: mergeAnalysisItems(groundedPlan.reviewSections, analysis.reviewSections, "title", 8),
    importantConcepts: mergeAnalysisItems(groundedPlan.importantConcepts, analysis.importantConcepts, "name", 8),
    recurringMistakes: mergeAnalysisItems(groundedPlan.recurringMistakes, analysis.recurringMistakes, "mistake", 6),
    trainingGoals: mergeAnalysisItems(groundedPlan.trainingGoals, analysis.trainingGoals, "title", 8),
    drills: analysis.drills,
    keyMoments: mergeKeyMoments(analysis.keyMoments, groundedPlan.keyMoments, 8),
    metadata: {
      ...analysis.metadata,
      groundedEnrichment: true,
    },
  };

  if (!enriched.importantConcepts.length) {
    enriched.importantConcepts = groundedPlan.importantConcepts || [];
  }

  if (!enriched.trainingGoals.length) {
    enriched.trainingGoals = groundedPlan.trainingGoals || [];
  }

  if (!enriched.keyMoments.length) {
    enriched.keyMoments = groundedPlan.keyMoments || [];
  }

  return enriched;
}

function validateAnalysisEvidence(analysis, transcript) {
  const context = inferTranscriptContext(transcript);
  const transcriptKey = normalizeTranscriptEvidenceKey(transcript);
  const stats = {
    removedReviewSections: 0,
    removedImportantConcepts: 0,
    removedRecurringMistakes: 0,
    removedTrainingGoals: 0,
    removedDrills: 0,
    removedKeyMoments: 0,
  };

  const reviewSections = filterEvidenceItems(
    analysis.reviewSections,
    transcript,
    transcriptKey,
    context,
    (item) => `${item.title} ${item.takeaway}`,
    "removedReviewSections",
    stats
  );
  const importantConcepts = filterEvidenceItems(
    analysis.importantConcepts,
    transcript,
    transcriptKey,
    context,
    (item) => `${item.name} ${item.category} ${item.whyItMatters}`,
    "removedImportantConcepts",
    stats
  );
  const recurringMistakes = filterEvidenceItems(
    analysis.recurringMistakes,
    transcript,
    transcriptKey,
    context,
    (item) => `${item.mistake} ${item.fix}`,
    "removedRecurringMistakes",
    stats
  );
  const trainingGoals = filterEvidenceItems(
    analysis.trainingGoals,
    transcript,
    transcriptKey,
    context,
    (item) => `${item.title} ${item.description} ${item.targetConcept}`,
    "removedTrainingGoals",
    stats
  );
  const drills = filterEvidenceItems(
    analysis.drills,
    transcript,
    transcriptKey,
    context,
    (item) => `${item.name} ${normalizeArray(item.steps).join(" ")}`,
    "removedDrills",
    stats
  );
  const keyMoments = normalizeArray(analysis.keyMoments).filter((item) => {
    const keep = hasTranscriptEvidence(item.text, transcript, transcriptKey);
    if (!keep) {
      stats.removedKeyMoments += 1;
    }
    return keep;
  });

  return {
    ...analysis,
    reviewSections,
    importantConcepts,
    recurringMistakes,
    trainingGoals,
    drills,
    keyMoments,
    metadata: {
      ...analysis.metadata,
      evidenceValidation: {
        enabled: true,
        ...stats,
      },
    },
  };
}

function filterEvidenceItems(items, transcript, transcriptKey, context, labelFn, statsKey, stats) {
  return normalizeArray(items).filter((item) => {
    const label = safeString(labelFn(item), "");
    const keep =
      hasTranscriptEvidence(item.evidence, transcript, transcriptKey) &&
      labelMatchesTranscriptContext(label, context);

    if (!keep) {
      stats[statsKey] += 1;
    }

    return keep;
  });
}

function hasTranscriptEvidence(evidence, transcript, transcriptKey) {
  const evidenceKey = normalizeEvidenceKey(evidence);

  if (!evidenceKey || evidenceKey.length < 8) {
    return false;
  }

  if (transcriptKey.includes(evidenceKey)) {
    return true;
  }

  const evidenceTokens = evidenceKey.split(" ").filter((token) => token.length > 2);

  if (evidenceTokens.length < 3) {
    return false;
  }

  const transcriptTokens = new Set(transcriptKey.split(" "));
  const overlap = evidenceTokens.filter((token) => transcriptTokens.has(token)).length;
  return overlap / evidenceTokens.length >= 0.8;
}

function normalizeTranscriptEvidenceKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function labelMatchesTranscriptContext(label, context) {
  const clean = label.toLowerCase();
  const rules = [
    { phrases: ["jungle", "jungler", "gank", "camp", "invade", "clear"], contexts: ["jungle"] },
    { phrases: ["top lane", "teleport", "split push", "side lane"], contexts: ["top", "laning"] },
    { phrases: ["mid lane", "roam", "river priority"], contexts: ["mid"] },
    { phrases: ["adc", "marksman", "damage uptime", "front to back"], contexts: ["adc", "teamfight"] },
    { phrases: ["support", "roam timer", "enchanter"], contexts: ["support"] },
    { phrases: ["bot lane", "2v2", "level 2"], contexts: ["bot_2v2", "adc", "support"] },
  ];

  return rules.every((rule) => {
    const mentionsRule = rule.phrases.some((phrase) => clean.includes(phrase));
    return !mentionsRule || rule.contexts.some((key) => context[key]);
  });
}

function mergeAnalysisItems(primary = [], secondary = [], labelKey, limit) {
  const seen = new Set();
  const merged = [];

  [...normalizeArray(primary), ...normalizeArray(secondary)].forEach((item) => {
    const label = canonicalAnalysisLabel(safeString(item[labelKey], ""));

    if (!label || seen.has(label)) {
      return;
    }

    seen.add(label);
    merged.push(item);
  });

  return merged.slice(0, limit);
}

function canonicalAnalysisLabel(label) {
  const clean = label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  if (clean.includes("champion") && (clean.includes("select") || clean.includes("comfort"))) {
    return "champion-comfort";
  }

  if (clean.includes("game plan") || clean.includes("lane plan") || clean.includes("planning")) {
    return "pre-game-lane-plan";
  }

  if (clean.includes("gank") || clean.includes("winning lane") || clean.includes("cc")) {
    return "gank-setup";
  }

  if (clean.includes("objective") || clean.includes("priority") || clean.includes("prio")) {
    return "objective-priority";
  }

  if (
    clean.includes("enemy jungler") ||
    clean.includes("enemy jungle") ||
    clean.includes("countergank") ||
    clean.includes("threat tracking")
  ) {
    return "enemy-threat-tracking";
  }

  if (clean.includes("jungler type") || clean.includes("jungle playstyle")) {
    return "jungle-playstyle-identity";
  }

  if (clean.includes("jungle mental") || clean.includes("clearing awareness")) {
    return "jungle-mental-stack";
  }

  if (clean.includes("invade") || clean.includes("matchup")) {
    return "jungle-matchup-invades";
  }

  return clean;
}

function mergeKeyMoments(primary = [], secondary = [], limit) {
  const seen = new Set();
  const merged = [];

  [...normalizeArray(primary), ...normalizeArray(secondary)].forEach((item) => {
    const key = `${Math.round(Number(item.time) || 0)}-${safeString(item.topic, "").toLowerCase()}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push(item);
  });

  return merged.slice(0, limit);
}

function hasStructuredAnalysis(analysis) {
  return [
    analysis.reviewSections,
    analysis.importantConcepts,
    analysis.recurringMistakes,
    analysis.trainingGoals,
    analysis.drills,
    analysis.keyMoments,
  ].some((items) => Array.isArray(items) && items.length > 0);
}

function retrieveKnowledgeDocuments(transcript) {
  const transcriptTokens = tokenizeForKnowledge(transcript);
  const context = inferTranscriptContext(transcript);

  if (!transcriptTokens.length) {
    return [];
  }

  return listKnowledgeDocuments()
    .map((document) => ({
      ...document,
      score: scoreKnowledgeDocument(transcript, transcriptTokens, document, context),
    }))
    .filter((document) => document.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, knowledgeTopK);
}

function formatKnowledgeContext(documents) {
  return documents
    .map((document) => {
      const clippedContent = document.content.slice(0, knowledgeMaxChars).trim();
      return `### ${document.title}\nSource: ${document.file}\n${clippedContent}`;
    })
    .join("\n\n");
}

function clipText(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }

  const headLength = Math.floor(maxChars * 0.65);
  const tailLength = maxChars - headLength;
  return `${text.slice(0, headLength)}\n\n[Transcript clipped for local model context. Middle omitted.]\n\n${text.slice(
    -tailLength
  )}`;
}

function listKnowledgeDocuments() {
  return fs
    .readdirSync(knowledgeDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const content = fs.readFileSync(path.join(knowledgeDir, file), "utf8");
      const titleMatch = content.match(/^#\s+(.+)$/m);

      return {
        file,
        title: titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/i, ""),
        content,
      };
    });
}

function scoreKnowledgeDocument(transcript, transcriptTokens, document, context) {
  const documentTokens = new Set(tokenizeForKnowledge(`${document.title} ${document.content}`));
  const transcriptLower = transcript.toLowerCase();
  const documentKey = `${document.file} ${document.title}`.toLowerCase();
  let score = 0;

  if (!documentMatchesTranscriptContext(documentKey, context)) {
    return 0;
  }

  transcriptTokens.forEach((token) => {
    if (documentTokens.has(token)) {
      score += 1;
    }
  });

  score += scoreKnowledgeBoosts(transcriptLower, documentKey, context);

  return score;
}

function documentMatchesTranscriptContext(documentKey, context) {
  const requirements = [
    { keys: ["top-lane-side-lane-matchups"], contexts: ["top", "laning"] },
    { keys: ["mid-lane-roaming-priority"], contexts: ["mid"] },
    { keys: ["adc-positioning-damage-uptime"], contexts: ["adc", "teamfight"] },
    { keys: ["support-vision-roaming-lane-control"], contexts: ["support", "vision"] },
    { keys: ["bot-lane-2v2-trading"], contexts: ["bot_2v2", "adc", "support", "laning"] },
    { keys: ["jungle-pathing-tracking"], contexts: ["jungle"] },
    { keys: ["objective-control"], contexts: ["objective"] },
    { keys: ["wave-management-laning", "trading-cooldowns-lane-combat"], contexts: ["laning"] },
    { keys: ["positioning-teamfighting"], contexts: ["teamfight"] },
    { keys: ["vision-map-awareness"], contexts: ["vision", "objective", "jungle"] },
    { keys: ["recalls-resets-item-timings"], contexts: ["recall", "laning", "objective"] },
    { keys: ["mechanics-execution-practice"], contexts: ["mechanics"] },
  ];

  const rule = requirements.find((item) => item.keys.some((key) => documentKey.includes(key)));

  if (!rule) {
    return true;
  }

  return rule.contexts.some((key) => context[key]);
}

function scoreKnowledgeBoosts(transcript, documentKey, context) {
  const boosts = [
    {
      phrases: ["top lane", "top laner", "teleport", "side lane", "split push", "splitpushing"],
      documents: ["top-lane-side-lane-matchups", "role-specific-responsibilities"],
      value: 24,
    },
    {
      phrases: ["mid lane", "mid laner", "roam", "roaming", "river control", "mid priority"],
      documents: ["mid-lane-roaming-priority", "role-specific-responsibilities"],
      value: 24,
    },
    {
      phrases: ["adc", "marksman", "bot carry", "damage uptime", "front to back", "front-to-back", "kite", "kiting"],
      documents: ["adc-positioning-damage-uptime", "positioning-teamfighting", "role-specific-responsibilities"],
      value: 24,
    },
    {
      phrases: ["support", "roam timer", "roam timing", "sweeper", "engage support", "enchanter", "peel"],
      documents: ["support-vision-roaming-lane-control", "vision-map-awareness", "role-specific-responsibilities"],
      value: 24,
    },
    {
      phrases: ["bot lane", "2v2", "level 2", "level two", "all in", "all-in", "poke lane", "sustain lane"],
      documents: ["bot-lane-2v2-trading", "trading-cooldowns-lane-combat", "wave-management-laning"],
      value: 22,
    },
    {
      phrases: ["jungle", "jungler", "junglers", "gank", "ganking", "invade", "camp", "camps"],
      documents: ["jungle-pathing-tracking", "role-specific-responsibilities"],
      value: 22,
    },
    {
      phrases: ["supportive junglers", "carry junglers", "tank junglers", "playstyle", "win condition"],
      documents: ["champion-identity-win-conditions", "role-specific-responsibilities"],
      value: 26,
      requiresAnyContext: ["jungle", "teamfight", "champion_identity"],
    },
    {
      phrases: ["champion select", "comfortable champion", "mechanics", "jungle champion"],
      documents: ["champion-identity-win-conditions", "mechanics-execution-practice"],
      value: 20,
    },
    {
      phrases: ["objective", "objectives", "dragons", "heralds", "prio", "priority"],
      documents: ["objective-control"],
      value: 24,
    },
    {
      phrases: ["map awareness", "enemy team", "counter option", "caught by surprise"],
      documents: ["vision-map-awareness", "mental-process-and-autopilot"],
      value: 18,
    },
    {
      phrases: ["winning lane", "cc", "crowd control", "lane matchups", "hp advantage"],
      documents: ["wave-management-laning", "trading-cooldowns-lane-combat"],
      value: 18,
    },
  ];

  return boosts.reduce((total, boost) => {
    const hasPhrase = boost.phrases.some((phrase) => transcript.includes(phrase));
    const hasDocument = boost.documents.some((document) => documentKey.includes(document));
    const hasContext =
      !boost.requiresAnyContext || boost.requiresAnyContext.some((key) => context[key]);
    return hasPhrase && hasDocument && hasContext ? total + boost.value : total;
  }, 0);
}

function inferTranscriptContext(transcript) {
  const lower = transcript.toLowerCase();
  const hasAny = (phrases) => phrases.some((phrase) => lower.includes(phrase));

  return {
    top: hasAny(["top lane", "top laner", "teleport", "side lane", "split push", "splitpushing", "bruiser"]),
    mid: hasAny(["mid lane", "mid laner", "roam", "roaming", "river", "mage", "assassin"]),
    adc: hasAny(["adc", "marksman", "bot carry", "damage uptime", "front to back", "front-to-back", "kite", "kiting"]),
    support: hasAny(["support", "roam timer", "roam timing", "sweeper", "engage support", "enchanter", "peel"]),
    bot_2v2: hasAny(["bot lane", "2v2", "level 2", "level two", "all in", "all-in", "poke lane", "sustain lane"]),
    jungle: hasAny(["jungle", "jungler", "gank", "ganking", "invade", "camp", "camps", "clear path", "full clear"]),
    laning: hasAny(["wave", "freeze", "slow push", "crash", "cs", "trade", "trading", "lane", "minion"]),
    teamfight: hasAny(["teamfight", "fight", "frontline", "backline", "peel", "engage", "flank", "positioning"]),
    vision: hasAny(["ward", "wards", "vision", "sweeper", "control ward", "fog", "face check", "facecheck"]),
    objective: hasAny(["objective", "dragon", "baron", "herald", "grubs", "tower", "turret", "elder"]),
    recall: hasAny(["recall", "reset", "base", "buy", "item spike", "spend gold", "shopping"]),
    mechanics: hasAny(["mechanic", "mechanics", "combo", "ability", "cooldown", "skillshot", "execution"]),
    champion_identity: hasAny(["champion identity", "win condition", "scaling", "carry", "tank", "frontline", "split push"]),
  };
}

function formatTranscriptContext(context) {
  const active = Object.entries(context)
    .filter(([, value]) => value)
    .map(([key]) => key.replaceAll("_", " "));

  if (!active.length) {
    return "No strong role/topic context detected. Use only direct transcript wording for labels.";
  }

  return active.join(", ");
}

function tokenizeForKnowledge(text) {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "because",
    "before",
    "coach",
    "could",
    "from",
    "game",
    "going",
    "have",
    "just",
    "league",
    "like",
    "more",
    "need",
    "really",
    "right",
    "that",
    "their",
    "then",
    "there",
    "this",
    "video",
    "want",
    "when",
    "with",
    "your",
  ]);

  return [...new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !stopWords.has(token))
  )];
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
  const themeMatches = extractCoachingThemes(sentences).slice(0, 8);
  const fallbackMatches = sentences
    .map((sentence) => ({
      theme: {
        name: "Coach instruction",
        category: "review_note",
        takeaway: "The coach gives an actionable instruction that should be reviewed directly.",
        goal: "Choose one coach instruction from the transcript and apply it in the next game.",
      },
      evidence: sentence,
      score: scoreGeneralCoachingSentence(sentence),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  const selectedMatches = themeMatches.length > 0 ? themeMatches : fallbackMatches;

  const reviewSections = selectedMatches.map((match) => ({
    title: match.theme.name,
    takeaway: match.theme.takeaway,
    evidence: match.evidence,
  }));

  const importantConcepts = selectedMatches.map((match, index) => ({
    name: match.theme.name,
    category: match.theme.category,
    whyItMatters: `${match.theme.takeaway} Evidence: "${match.evidence}"`,
    frequency: Math.max(45, 100 - index * 9),
    evidence: match.evidence,
  }));

  const trainingGoals = selectedMatches.slice(0, 8).map((match) => ({
    title: match.theme.name,
    description: match.theme.goal,
    targetConcept: match.theme.name,
    evidence: match.evidence,
  }));

  const recurringMistakes = selectedMatches
    .filter((match) => match.theme.mistake)
    .slice(0, 6)
    .map((match) => ({
      mistake: match.theme.mistake,
      evidence: match.evidence,
      fix: match.theme.fix,
    }));

  const keyMoments = buildGroundedKeyMoments(selectedMatches, fallbackSegments);
  const themeNames = selectedMatches.map((match) => match.theme.name.toLowerCase()).slice(0, 3);

  return {
    summary:
      selectedMatches.length > 0
        ? `RankUp found ${selectedMatches.length} transcript-backed coaching themes in ${fileName}: ${themeNames.join(
            ", "
          )}.`
        : `RankUp extracted shareable coach notes from ${fileName}. Items below are direct transcript excerpts.`,
    reviewSections,
    importantConcepts,
    recurringMistakes,
    trainingGoals,
    keyMoments,
    metadata: {
      analysisMode: "local_grounded",
      wordCount,
      confidence: "evidence_based",
    },
  };
}

function extractCoachingThemes(sentences) {
  const usedEvidence = new Set();

  return getCoachingThemes()
    .map((theme) => {
      const candidates = sentences
        .map((sentence) => ({
          theme,
          evidence: sentence,
          score: scoreThemeSentence(sentence, theme),
        }))
        .filter((candidate) => candidate.score >= 3)
        .sort((a, b) => b.score - a.score);

      return candidates[0];
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .filter((match) => {
      const key = normalizeEvidenceKey(match.evidence);

      if (usedEvidence.has(key)) {
        return false;
      }

      usedEvidence.add(key);
      return true;
    });
}

function getCoachingThemes() {
  return [
    {
      name: "Jungle Playstyle Identity",
      category: "macro",
      keywords: ["supportive", "carry", "tank", "frontline", "bruiser", "playstyle"],
      requiredContext: ["jungle", "jungler", "junglers", "gank", "ganking", "camp", "camps", "clear", "clearing"],
      takeaway: "The player should choose a jungle style that matches how they want to impact the game.",
      goal: "Before queueing, write whether this game plan is carry, supportive, or frontline, then pick a champion that fits that job.",
      mistake: "Playing jungle without a clear role identity.",
      fix: "Decide whether the champion is meant to carry, enable lanes, or frontline before the game starts.",
    },
    {
      name: "Champion Comfort In Select",
      category: "mechanics",
      keywords: ["champion select", "comfortable", "mechanics", "mechanically", "pick a champion"],
      requiredContext: ["champion select", "pick", "champion", "mechanics", "mechanically"],
      takeaway: "A comfortable champion lowers mechanical load so the player can spend attention on the map and decisions.",
      goal: "Use a small champion pool and only review new concepts on champions whose core patterns feel automatic.",
      mistake: "Picking champions that demand too much mechanical attention during a mentally loaded role.",
      fix: "Choose comfort picks while learning role fundamentals.",
    },
    {
      name: "Wave And Recall Setup",
      category: "laning",
      keywords: ["wave", "freeze", "slow push", "crash", "recall", "reset", "cs", "minion"],
      requiredContext: ["wave", "freeze", "slow push", "crash", "recall", "reset", "cs", "minion"],
      takeaway: "Lane decisions should create clean recall, roam, trade, or objective windows.",
      goal: "Before recalling or roaming, name the wave state and what it lets you do next.",
      mistake: "Moving or resetting without first fixing the wave state.",
      fix: "Review the wave before leaving lane and decide whether to crash, hold, freeze, or reset.",
    },
    {
      name: "Trading Around Cooldowns",
      category: "laning",
      keywords: ["trade", "trading", "cooldown", "ability", "level advantage", "minion wave", "poke"],
      requiredContext: ["trade", "trading", "cooldown", "ability", "level advantage", "minion"],
      takeaway: "Good trades happen when cooldowns, wave size, and level advantage support the fight.",
      goal: "Before each trade, check the enemy key cooldown and the size of the wave.",
      mistake: "Trading without cooldown or wave advantage.",
      fix: "Only trade when the transcript-supported setup condition is present.",
    },
    {
      name: "Teamfight Positioning",
      category: "positioning",
      keywords: ["teamfight", "fight", "position", "positioning", "frontline", "backline", "peel", "engage", "flank"],
      requiredContext: ["teamfight", "fight", "position", "positioning", "frontline", "backline", "peel", "engage", "flank"],
      takeaway: "Fight impact depends on standing where the champion can do their job without giving away a free engage.",
      goal: "Before the next fight, state your job and the enemy threat you must respect.",
      mistake: "Entering fights without a clear job or threat check.",
      fix: "Pause before fights to identify engage tools, target access, and safe spacing.",
    },
    {
      name: "Vision And Fog Safety",
      category: "vision",
      keywords: ["ward", "wards", "vision", "sweeper", "control ward", "fog", "face check", "facecheck"],
      requiredContext: ["ward", "wards", "vision", "sweeper", "control ward", "fog", "face check", "facecheck"],
      takeaway: "Vision should support the next play and prevent walking into unknown threat.",
      goal: "Before entering fog, identify which enemies are missing and what vision covers the path.",
      mistake: "Moving through fog without information.",
      fix: "Use wards, sweepers, and visible enemy positions before crossing unsafe areas.",
    },
    {
      name: "Champion Job And Win Condition",
      category: "macro",
      keywords: ["win condition", "champion identity", "scaling", "split push", "frontline", "carry", "peel"],
      requiredContext: ["win condition", "champion identity", "scaling", "split push", "frontline", "carry", "peel"],
      takeaway: "The player should connect decisions to what their champion or team composition is trying to accomplish.",
      goal: "Before fights and rotations, state whether your job is damage, engage, peel, side lane, or scaling.",
      mistake: "Making plays that do not match the champion or team win condition.",
      fix: "Review each major decision against the champion's intended job.",
    },
    {
      name: "Pre-Game Lane Plan",
      category: "macro",
      keywords: ["game plan", "decide", "which lanes", "play through", "forecast", "lane needs help", "snowball"],
      requiredContext: ["jungle", "jungler", "gank", "ganking", "camp", "clear", "path", "pathing"],
      takeaway: "The jungler should enter the game with a lane plan instead of reacting randomly.",
      goal: "During loading screen, choose the first lane to watch and the first lane that can become a win condition.",
      mistake: "Starting the game without deciding which lane to play through.",
      fix: "Forecast lane states before camps spawn and update the plan while clearing.",
    },
    {
      name: "Gank Setup: Winning Lanes And CC",
      category: "laning",
      keywords: ["winning lane", "cs", "trades", "hp advantage", "cc", "gank that lane", "crowd control", "lane matchups"],
      requiredContext: ["gank", "ganking", "lane", "lanes", "cc", "crowd control"],
      takeaway: "Good ganks are selected from lane state, crowd control, damage, and matchup volatility.",
      goal: "Before every gank, check whether the lane has CC, damage, HP advantage, or a volatile matchup.",
      mistake: "Ganking lanes without setup while ignoring stronger lanes.",
      fix: "Prioritize lanes that are already winning or have reliable CC and damage.",
    },
    {
      name: "Enemy Threat Tracking",
      category: "macro",
      keywords: ["enemy jungler", "enemy jungle", "enemy counterplay", "enemy response", "countergank", "counter-gank", "counter option", "enemy win condition", "threat tracking"],
      requiredContext: ["enemy jungler", "enemy jungle", "countergank", "counter-gank", "enemy counterplay", "threat tracking", "gank", "objective"],
      takeaway: "Strong jungle decisions include both allied setup and enemy counterplay.",
      goal: "Before committing to a gank, invade, or objective, name the enemy's most likely counter-option.",
      mistake: "Only thinking about allied champion setup while ignoring what enemies can do.",
      fix: "Review enemy laner and enemy jungler options before choosing the play.",
    },
    {
      name: "Jungle Matchup And Invades",
      category: "macro",
      keywords: ["jungle matchup", "invade", "camp", "stronger early game", "get a kill", "get a camp"],
      requiredContext: ["jungle", "jungler", "invade", "camp", "camps", "clear", "clearing"],
      takeaway: "Jungle matchup knowledge can create invade windows, camp steals, and early pressure.",
      goal: "Identify one matchup-based invade or tracking opportunity in the first clear review.",
      mistake: "Missing invade windows when the jungle matchup is stronger.",
      fix: "Use matchup strength and lane priority to decide whether an invade is available.",
    },
    {
      name: "Objective Control With Priority",
      category: "objective_control",
      keywords: ["objective", "objectives", "dragons", "heralds", "prio", "lanes move", "laners win a fight", "solo objective"],
      takeaway: "Objective calls depend on lane priority, nearby help, fight strength, and enemy response.",
      goal: "Before dragon, Herald, or Baron, ask: do lanes have priority, can they move, and what is the enemy doing?",
      mistake: "Starting objectives without priority or enemy information.",
      fix: "Confirm lane movement and enemy position before committing to the objective.",
    },
    {
      name: "Jungle Mental Stack",
      category: "review_note",
      keywords: ["mentally taxing", "lanes", "map awareness", "objectives", "camps", "every single lane"],
      requiredContext: ["jungle", "jungler", "camp", "camps", "clear", "clearing"],
      takeaway: "Jungle requires managing camps while reading lanes, map state, and objectives.",
      goal: "While clearing, check one lane after each camp and connect that information to your next pathing decision.",
      mistake: "Clearing camps without using the downtime to read the map.",
      fix: "Build a repeatable scan habit during every camp.",
    },
  ];
}

function scoreThemeSentence(sentence, theme) {
  const lower = sentence.toLowerCase();

  if (isFillerSentence(lower)) {
    return -10;
  }

  if (theme.requiredContext && !theme.requiredContext.some((phrase) => lower.includes(phrase))) {
    return -10;
  }

  const keywordScore = theme.keywords.reduce(
    (score, keyword) => score + (lower.includes(keyword) ? 2 : 0),
    0
  );
  const actionScore = isActionableSentence(sentence) ? 2 : 0;
  const coachingScore = isCoachingSentence(sentence) ? 1 : 0;
  const causalScore = ["because", "so", "if", "then", "reason"].some((word) => lower.includes(word)) ? 1 : 0;
  const themeBoost = scoreThemeBoost(lower, theme.name);
  const lengthPenalty = sentence.length > 360 ? 2 : 0;

  return keywordScore + actionScore + coachingScore + causalScore + themeBoost - lengthPenalty;
}

function scoreThemeBoost(sentence, themeName) {
  if (
    themeName === "Objective Control With Priority" &&
    ["prior", "prio", "lanes move", "help me do the objective", "solo objective"].some((phrase) =>
      sentence.includes(phrase)
    )
  ) {
    return 6;
  }

  if (
    themeName === "Gank Setup: Winning Lanes And CC" &&
    ["winning lane", "has cc", "gank that lane", "hp advantage", "lane matchups"].some((phrase) =>
      sentence.includes(phrase)
    )
  ) {
    return 6;
  }

  return 0;
}

function scoreGeneralCoachingSentence(sentence) {
  const lower = sentence.toLowerCase();

  if (isFillerSentence(lower)) {
    return -10;
  }

  return (isActionableSentence(sentence) ? 3 : 0) + (isCoachingSentence(sentence) ? 2 : 0);
}

function isFillerSentence(lower) {
  return [
    "welcome back",
    "my name",
    "stay tuned",
    "thanks for watching",
    "going over the basics",
    "from the ground up",
    "played on teams",
    "lcs",
  ].some((phrase) => lower.includes(phrase));
}

function normalizeEvidenceKey(evidence) {
  return evidence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 100);
}

function buildGroundedKeyMoments(matches, fallbackSegments) {
  const moments = matches
    .map((match) => {
      const segment = findSegmentForEvidence(match.evidence, fallbackSegments);
      return {
        time: segment ? segment.start : 0,
        text: segment ? segment.text : match.evidence,
        topic: match.theme.name,
      };
    })
    .filter((moment) => moment.text && moment.text.trim());

  return moments.length > 0
    ? moments.slice(0, 8)
    : fallbackSegments
        .filter((segment) => segment.text && segment.text.trim())
        .slice(0, 8)
        .map((segment) => ({
          time: segment.start,
          text: segment.text,
          topic: "Transcript moment",
        }));
}

function findSegmentForEvidence(evidence, segments) {
  const evidenceKey = evidence.toLowerCase().slice(0, 90);

  return segments.find((segment) => {
    const text = (segment.text || "").toLowerCase();
    return text.includes(evidenceKey) || evidenceKey.includes(text.slice(0, 60));
  });
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
    return transcription.segments.slice(0, 80).map((segment) => ({
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

async function saveReview(review) {
  const safeName = review.fileName
    ? review.fileName.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-")
    : "review";
  const fileName = `${review.createdAt.replace(/[:.]/g, "-")}-${safeName}.json`;
  const reviewPath = path.join(reviewDir, fileName);
  const latestPath = path.join(reviewDir, "latest-review.json");

  fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify({ ...review, savedAs: fileName }, null, 2));
  pruneSavedReviews();

  if (db) {
    try {
      await saveReviewToDatabase(review, fileName);
    } catch (error) {
      console.error(`PostgreSQL save failed: ${error.message}`);
    }
  }
}

async function listReviewSummaries() {
  if (db) {
    try {
      return await listDatabaseReviews();
    } catch (error) {
      console.error(`PostgreSQL review list failed: ${error.message}`);
    }
  }

  return listSavedReviews();
}

function listSavedReviews() {
  return getReviewFiles()
    .map((file) => {
      const review = readReviewFile(file);

      return {
        id: review.id,
        createdAt: review.createdAt,
        status: review.status,
        fileName: review.fileName,
        savedAs: file,
        transcriptLength: review.transcript ? review.transcript.length : 0,
        segmentCount: Array.isArray(review.segments) ? review.segments.length : 0,
      };
    });
}

async function getLatestReview() {
  if (db) {
    try {
      const latest = await getLatestDatabaseReview();

      if (latest) {
        return latest;
      }
    } catch (error) {
      console.error(`PostgreSQL latest review failed: ${error.message}`);
    }
  }

  return getLatestSavedReview();
}

async function getReviewById(id) {
  if (db) {
    try {
      await initializeDatabase();
      const result = await db.query("SELECT raw_review FROM rankup_reviews WHERE id = $1 LIMIT 1", [id]);

      if (result.rows[0]) {
        return result.rows[0].raw_review;
      }
    } catch (error) {
      console.error(`PostgreSQL review lookup failed: ${error.message}`);
    }
  }

  const file = getReviewFiles().find((reviewFile) => {
    try {
      return readReviewFile(reviewFile).id === id;
    } catch (_error) {
      return false;
    }
  });

  return file ? { ...readReviewFile(file), savedAs: file } : null;
}

function getLatestSavedReview() {
  const latestPath = path.join(reviewDir, "latest-review.json");

  if (!fs.existsSync(latestPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(latestPath, "utf8"));
}

function readReviewFile(file) {
  return JSON.parse(fs.readFileSync(path.join(reviewDir, file), "utf8"));
}

function pruneSavedReviews() {
  const reviewFiles = getReviewFiles();

  reviewFiles.slice(maxSavedReviews).forEach((file) => {
    fs.rmSync(path.join(reviewDir, file), { force: true });
  });
}

function clearSavedReviews() {
  const files = fs
    .readdirSync(reviewDir)
    .filter((file) => file.endsWith(".json"));

  files.forEach((file) => {
    fs.rmSync(path.join(reviewDir, file), { force: true });
  });

  return files.length;
}

function getReviewFiles() {
  return fs
    .readdirSync(reviewDir)
    .filter((file) => file.endsWith(".json") && file !== "latest-review.json")
    .sort()
    .reverse();
}

function createReviewId() {
  return `review_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function createProcessingTimer() {
  const startedAt = Date.now();
  const stages = {
    audioExtractionMs: null,
    transcriptionMs: null,
    analysisMs: null,
  };

  return {
    startStage(name) {
      const stageStartedAt = Date.now();
      return () => {
        stages[name] = Date.now() - stageStartedAt;
      };
    },
    finish() {
      return {
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        processingMs: Date.now() - startedAt,
        ...stages,
      };
    },
  };
}

async function initializeDatabase() {
  if (!db) {
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS rankup_reviews (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      file_name TEXT NOT NULL,
      saved_as TEXT,
      transcript TEXT,
      analysis_summary TEXT,
      analysis_mode TEXT,
      confidence TEXT,
      transcribe_provider TEXT,
      analysis_provider TEXT,
      local_whisper_model TEXT,
      ollama_model TEXT,
      word_count INTEGER,
      segment_count INTEGER NOT NULL DEFAULT 0,
      processing_ms INTEGER,
      audio_extraction_ms INTEGER,
      transcription_ms INTEGER,
      analysis_ms INTEGER,
      raw_review JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rankup_review_segments (
      id BIGSERIAL PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES rankup_reviews(id) ON DELETE CASCADE,
      start_seconds INTEGER NOT NULL,
      end_seconds INTEGER,
      text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rankup_focus_areas (
      id BIGSERIAL PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES rankup_reviews(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      why_it_matters TEXT,
      evidence TEXT,
      frequency INTEGER
    );

    CREATE TABLE IF NOT EXISTS rankup_recurring_mistakes (
      id BIGSERIAL PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES rankup_reviews(id) ON DELETE CASCADE,
      mistake TEXT NOT NULL,
      fix TEXT,
      evidence TEXT
    );

    CREATE TABLE IF NOT EXISTS rankup_training_goals (
      id BIGSERIAL PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES rankup_reviews(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      target_concept TEXT,
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      coach_note TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rankup_knowledge_sources (
      id BIGSERIAL PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES rankup_reviews(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      title TEXT,
      score INTEGER
    );
  `);

  await db.query("ALTER TABLE rankup_training_goals ADD COLUMN IF NOT EXISTS coach_note TEXT");
  await db.query("ALTER TABLE rankup_training_goals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await db.query("ALTER TABLE rankup_reviews ADD COLUMN IF NOT EXISTS processing_ms INTEGER");
  await db.query("ALTER TABLE rankup_reviews ADD COLUMN IF NOT EXISTS audio_extraction_ms INTEGER");
  await db.query("ALTER TABLE rankup_reviews ADD COLUMN IF NOT EXISTS transcription_ms INTEGER");
  await db.query("ALTER TABLE rankup_reviews ADD COLUMN IF NOT EXISTS analysis_ms INTEGER");
}

async function saveReviewToDatabase(review, savedAs) {
  await initializeDatabase();

  const analysis = review.analysis || {};
  const metadata = analysis.metadata || {};
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO rankup_reviews (
          id,
          created_at,
          status,
          file_name,
          saved_as,
          transcript,
          analysis_summary,
          analysis_mode,
          confidence,
          transcribe_provider,
          analysis_provider,
          local_whisper_model,
          ollama_model,
          word_count,
          segment_count,
          processing_ms,
          audio_extraction_ms,
          transcription_ms,
          analysis_ms,
          raw_review
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        ON CONFLICT (id) DO UPDATE SET
          raw_review = EXCLUDED.raw_review,
          analysis_summary = EXCLUDED.analysis_summary,
          analysis_mode = EXCLUDED.analysis_mode,
          confidence = EXCLUDED.confidence,
          processing_ms = EXCLUDED.processing_ms,
          audio_extraction_ms = EXCLUDED.audio_extraction_ms,
          transcription_ms = EXCLUDED.transcription_ms,
          analysis_ms = EXCLUDED.analysis_ms
      `,
      [
        review.id,
        review.createdAt,
        review.status,
        review.fileName,
        savedAs,
        review.transcript || "",
        analysis.summary || review.error || "",
        metadata.analysisMode || "",
        metadata.confidence || "",
        review.providers ? review.providers.transcribeProvider : "",
        review.providers ? review.providers.analysisProvider : "",
        review.providers ? review.providers.localWhisperModel : "",
        review.providers ? review.providers.ollamaModel : "",
        metadata.wordCount || countWords(review.transcript || ""),
        Array.isArray(review.segments) ? review.segments.length : 0,
        review.processing ? review.processing.processingMs : null,
        review.processing ? review.processing.audioExtractionMs : null,
        review.processing ? review.processing.transcriptionMs : null,
        review.processing ? review.processing.analysisMs : null,
        JSON.stringify(review),
      ]
    );

    await client.query("DELETE FROM rankup_review_segments WHERE review_id = $1", [review.id]);
    await client.query("DELETE FROM rankup_focus_areas WHERE review_id = $1", [review.id]);
    await client.query("DELETE FROM rankup_recurring_mistakes WHERE review_id = $1", [review.id]);
    await client.query("DELETE FROM rankup_training_goals WHERE review_id = $1", [review.id]);
    await client.query("DELETE FROM rankup_knowledge_sources WHERE review_id = $1", [review.id]);

    for (const segment of normalizeArray(review.segments)) {
      await client.query(
        "INSERT INTO rankup_review_segments (review_id, start_seconds, end_seconds, text) VALUES ($1, $2, $3, $4)",
        [review.id, Math.round(segment.start || 0), Math.round(segment.end || 0), segment.text || ""]
      );
    }

    for (const concept of normalizeArray(analysis.importantConcepts)) {
      await client.query(
        `
          INSERT INTO rankup_focus_areas (review_id, name, category, why_it_matters, evidence, frequency)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          review.id,
          concept.name || "Focus area",
          concept.category || "review_note",
          concept.whyItMatters || "",
          concept.evidence || "",
          Number.isFinite(Number(concept.frequency)) ? Number(concept.frequency) : null,
        ]
      );
    }

    for (const mistake of normalizeArray(analysis.recurringMistakes)) {
      await client.query(
        "INSERT INTO rankup_recurring_mistakes (review_id, mistake, fix, evidence) VALUES ($1, $2, $3, $4)",
        [review.id, mistake.mistake || "Recurring mistake", mistake.fix || "", mistake.evidence || ""]
      );
    }

    for (const goal of normalizeArray(analysis.trainingGoals)) {
      await client.query(
        `
          INSERT INTO rankup_training_goals (review_id, title, description, target_concept, evidence)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [
          review.id,
          goal.title || "Training goal",
          goal.description || "",
          goal.targetConcept || "",
          goal.evidence || "",
        ]
      );
    }

    for (const source of normalizeArray(metadata.knowledgeSources)) {
      await client.query(
        "INSERT INTO rankup_knowledge_sources (review_id, file_name, title, score) VALUES ($1, $2, $3, $4)",
        [review.id, source.file || source.file_name || "", source.title || "", Number(source.score) || 0]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listDatabaseReviews() {
  await initializeDatabase();
  const result = await db.query(`
    SELECT
      id,
      created_at,
      status,
      file_name,
      saved_as,
      LENGTH(COALESCE(transcript, '')) AS transcript_length,
      segment_count,
      processing_ms,
      analysis_mode,
      confidence
    FROM rankup_reviews
    ORDER BY created_at DESC
    LIMIT 50
  `);

  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    fileName: row.file_name,
    savedAs: row.saved_as,
    transcriptLength: Number(row.transcript_length || 0),
    segmentCount: row.segment_count,
    processingMs: row.processing_ms,
    analysisMode: row.analysis_mode,
    confidence: row.confidence,
  }));
}

async function getLatestDatabaseReview() {
  await initializeDatabase();
  const result = await db.query("SELECT raw_review FROM rankup_reviews ORDER BY created_at DESC LIMIT 1");
  return result.rows[0] ? result.rows[0].raw_review : null;
}

async function updateDatabaseGoal(goalId, { status, coachNote }) {
  await initializeDatabase();
  const result = await db.query(
    `
      UPDATE rankup_training_goals
      SET status = $2,
          coach_note = $3,
          updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        review_id,
        title,
        description,
        target_concept,
        evidence,
        status,
        coach_note,
        created_at,
        updated_at
    `,
    [goalId, status, coachNote]
  );

  return result.rows[0] || null;
}

async function getDashboardSummary() {
  if (!db) {
    return getJsonDashboardSummary();
  }

  try {
    await initializeDatabase();
    const [totals, focusAreas, goals, recentReviews] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int AS total_reviews,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_reviews,
          COUNT(*) FILTER (WHERE analysis_mode = 'ollama')::int AS ollama_reviews,
          MAX(created_at) AS last_review_at
        FROM rankup_reviews
      `),
      db.query(`
        SELECT name, category, COUNT(*)::int AS count
        FROM rankup_focus_areas
        GROUP BY name, category
        ORDER BY count DESC, name ASC
        LIMIT 8
      `),
      db.query(`
        SELECT
          goal.id,
          goal.review_id,
          review.file_name,
          review.created_at,
          goal.title,
          goal.description,
          goal.target_concept,
          goal.evidence,
          goal.status,
          goal.coach_note,
          goal.updated_at
        FROM rankup_training_goals goal
        JOIN rankup_reviews review ON review.id = goal.review_id
        ORDER BY review.created_at DESC, goal.id ASC
        LIMIT 24
      `),
      db.query(`
        SELECT id, file_name, created_at, analysis_mode, confidence, analysis_summary, processing_ms
        FROM rankup_reviews
        ORDER BY created_at DESC
        LIMIT 8
      `),
    ]);

    return {
      source: "postgres",
      totals: totals.rows[0],
      topFocusAreas: focusAreas.rows,
      recommendedGoals: goals.rows,
      recentReviews: recentReviews.rows,
    };
  } catch (error) {
    console.error(`PostgreSQL dashboard failed: ${error.message}`);
    return getJsonDashboardSummary();
  }
}

function getJsonDashboardSummary() {
  const reviews = getReviewFiles().map((file) => ({ ...readReviewFile(file), savedAs: file }));
  const completedReviews = reviews.filter((review) => review.status === "completed");
  const focusAreas = countItems(
    completedReviews.flatMap((review) => normalizeArray(review.analysis && review.analysis.importantConcepts)),
    "name"
  );
  const goals = completedReviews.flatMap((review) =>
    normalizeArray(review.analysis && review.analysis.trainingGoals).map((goal, index) => ({
      id: `${review.id}_${index}`,
      review_id: review.id,
      file_name: review.fileName,
      created_at: review.createdAt,
      title: goal.title,
      description: goal.description,
      target_concept: goal.targetConcept,
      evidence: goal.evidence,
      status: goal.status || "active",
    }))
  );

  return {
    source: "json",
    totals: {
      total_reviews: reviews.length,
      completed_reviews: completedReviews.length,
      ollama_reviews: completedReviews.filter(
        (review) => review.analysis && review.analysis.metadata && review.analysis.metadata.analysisMode === "ollama"
      ).length,
      last_review_at: reviews[0] ? reviews[0].createdAt : null,
    },
    topFocusAreas: focusAreas.slice(0, 8),
    recommendedGoals: goals.slice(0, 24),
    recentReviews: reviews.slice(0, 8).map((review) => ({
      id: review.id,
      file_name: review.fileName,
      created_at: review.createdAt,
      analysis_mode: review.analysis && review.analysis.metadata ? review.analysis.metadata.analysisMode : "",
      confidence: review.analysis && review.analysis.metadata ? review.analysis.metadata.confidence : "",
      analysis_summary: review.analysis ? review.analysis.summary : review.error,
      processing_ms: review.processing ? review.processing.processingMs : null,
    })),
  };
}

function countItems(items, key) {
  const counts = new Map();

  items.forEach((item) => {
    const label = item && item[key] ? item[key] : "Unknown";
    const current = counts.get(label) || { name: label, title: label, mistake: label, count: 0 };
    current.count += 1;
    current.category = item.category || current.category || "review_note";
    current.fix = item.fix || current.fix || "";
    current.description = item.description || current.description || "";
    current.target_concept = item.targetConcept || current.target_concept || "";
    counts.set(label, current);
  });

  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildJsonReviewTrend(reviews) {
  const counts = new Map();

  reviews.forEach((review) => {
    const day = (review.createdAt || "").slice(0, 10) || "unknown";
    counts.set(day, (counts.get(day) || 0) + 1);
  });

  return [...counts.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day));
}

function countWords(value) {
  return String(value).trim().split(/\s+/).filter(Boolean).length;
}

function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}
