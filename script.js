const pipelineSteps = [
  {
    label: "Upload VOD",
    detail: "Select the video file.",
  },
  {
    label: "Extract Audio",
    detail: "Pull out the audio track.",
  },
  {
    label: "Transcribe",
    detail: "Create timestamped text.",
  },
  {
    label: "Build Plan",
    detail: "Create evidence-backed goals.",
  },
];

const pipeline = document.querySelector("#pipeline");
const timeline = document.querySelector("#timeline");
const bars = document.querySelector("#bars");
const goalList = document.querySelector("#goals");
const aiOutput = document.querySelector("#aiOutput");
const processVod = document.querySelector("#processVod");
const pipelineStatus = document.querySelector("#pipelineStatus");
const fullTranscript = document.querySelector("#fullTranscript");
const copyTranscript = document.querySelector("#copyTranscript");
const loadLatest = document.querySelector("#loadLatest");
const clearSaved = document.querySelector("#clearSaved");
const uploadStage = document.querySelector("#uploadStage");
const vodInput = document.querySelector("#vodInput");
const fileChip = document.querySelector("#fileChip");
const videoPreview = document.querySelector("#videoPreview");
const vodPreview = document.querySelector("#vodPreview");
const navItems = document.querySelectorAll(".nav-item");
const jumpButtons = document.querySelectorAll("[data-jump]");

let selectedVod = null;
let objectUrl = null;
let latestTranscript = "";
let progressTimer = null;

pipeline.innerHTML = pipelineSteps
  .map(
    (step, index) => `
      <div class="pipeline-step" data-step="${index}">
        <span>${index + 1}</span>
        <div>
          <strong>${step.label}</strong>
          <p>${step.detail}</p>
        </div>
      </div>
    `
  )
  .join("");

timeline.innerHTML = emptyState("No transcript yet.");
bars.innerHTML = emptyState("No excerpts yet.");
goalList.innerHTML = emptyState("No action items yet.");

processVod.addEventListener("click", async () => {
  if (window.location.protocol === "file:") {
    aiOutput.innerHTML = `
      <p><strong>Server not connected:</strong> RankUp is open as a local HTML file.</p>
      <p class="placeholder">Start the app with <strong>npm run dev</strong>, then open <strong>http://localhost:3000</strong>. Upload processing cannot work from file://.</p>
    `;
    return;
  }

  if (!selectedVod) {
    fileChip.textContent = "Choose a video before transcribing";
    uploadStage.classList.add("dragging");
    setTimeout(() => uploadStage.classList.remove("dragging"), 900);
    return;
  }

  processVod.disabled = true;
  processVod.textContent = "Processing...";
  pipelineStatus.textContent = "Working";
  startProcessingVisual(selectedVod.name);

  const steps = document.querySelectorAll(".pipeline-step");
  steps.forEach((step) => step.classList.remove("complete", "processing"));

  steps.forEach((step, index) => {
    setTimeout(() => {
      steps.forEach((item) => item.classList.remove("processing"));
      step.classList.add("processing");

      if (index > 0) {
        steps[index - 1].classList.add("complete");
      }
    }, index * 520);
  });

  try {
    const formData = new FormData();
    formData.append("vod", selectedVod);

    const response = await fetch("/api/reviews", {
      method: "POST",
      body: formData,
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "VOD processing failed.");
    }

    stopProcessingVisual();
    steps.forEach((step) => step.classList.add("complete"));
    steps.forEach((step) => step.classList.remove("processing"));
    pipelineStatus.textContent = "Analyzed";
    processVod.textContent = "Analyze Another VOD";
    processVod.disabled = false;
    vodInput.value = "";
    renderReviewResult(result);
  } catch (error) {
    stopProcessingVisual();
    steps.forEach((step) => step.classList.remove("processing"));
    pipelineStatus.textContent = "Needs Attention";
    processVod.textContent = "Transcribe VOD";
    processVod.disabled = false;
    aiOutput.innerHTML = `
      <p><strong>Processing failed:</strong> ${error.message}</p>
      <p class="placeholder">Make sure the page is opened at <strong>http://localhost:3000</strong>, the server is running with <strong>npm run dev</strong>, and local Whisper is installed with <strong>npm run setup:local-whisper</strong>.</p>
    `;
  }
});

loadLatest.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/reviews/latest");
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "No saved review found.");
    }

    pipelineStatus.textContent = result.status === "completed" ? "Loaded" : "Failed";

    if (result.status === "failed") {
      aiOutput.innerHTML = `<p><strong>Latest review failed:</strong> ${escapeHtml(result.error)}</p>`;
      return;
    }

    renderReviewResult(result);
  } catch (error) {
    aiOutput.innerHTML = `<p><strong>Could not load latest review:</strong> ${escapeHtml(error.message)}</p>`;
  }
});

clearSaved.addEventListener("click", async () => {
  const response = await fetch("/api/reviews", { method: "DELETE" });
  const result = await response.json();

  latestTranscript = "";
  timeline.innerHTML = emptyState("No transcript yet.");
  bars.innerHTML = emptyState("No excerpts yet.");
  goalList.innerHTML = emptyState("No action items yet.");
  fullTranscript.textContent = "No transcript yet.";
  aiOutput.innerHTML = `<p>Cleared ${result.deleted || 0} saved review file(s).</p>`;
  pipelineStatus.textContent = "Ready";
});

function renderReviewResult(result) {
  const sections = result.analysis.reviewSections || [];
  const concepts = result.analysis.importantConcepts || [];
  const mistakes = result.analysis.recurringMistakes || [];
  const generatedGoals = result.analysis.trainingGoals || [];
  const drills = result.analysis.drills || [];
  const keyMoments = result.analysis.keyMoments || [];
  const segments = result.segments || [];
  latestTranscript = result.transcript || "";
  const hasAnalysis = hasStructuredReview(result.analysis);

  timeline.innerHTML =
    segments.length > 0
      ? segments
          .map(
            (segment) => `
        <div class="timestamp">
          <strong>${formatTime(segment.start)}</strong>
          <span>${escapeHtml(segment.text)}</span>
          <span class="tag transcript">audio</span>
        </div>
      `
          )
          .join("")
      : `<div class="timestamp"><strong>0:00</strong><span>No clear coach speech was detected in this file.</span><span class="tag transcript">audio</span></div>`;

  fullTranscript.textContent =
    latestTranscript.trim() ||
    "No clear speech detected. Try louder coach audio or set LOCAL_WHISPER_MODEL=base.";

  bars.innerHTML =
    sections.length > 0 || concepts.length > 0
      ? [...sections.map((section) => ({
          name: section.title,
          whyItMatters: `${section.takeaway}${section.evidence ? ` Evidence: "${section.evidence}"` : ""}`,
          frequency: 100,
        })), ...concepts]
          .slice(0, 10)
          .map((item, index) => {
            const value = Math.max(8, Math.min(100, Math.round(item.frequency || 80)));
            return `
        <div class="bar-row">
          <strong>${escapeHtml(item.name)}</strong>
          <div class="bar-track" aria-label="${escapeHtml(item.name)}: ${value}%">
            <div class="bar-fill" style="width: ${value}%"></div>
          </div>
          <span>${index + 1}</span>
        </div>
      `;
          })
          .join("")
      : emptyState("No excerpts found.");

  goalList.innerHTML =
    generatedGoals.length > 0 || drills.length > 0
      ? [...generatedGoals, ...drills.map((drill) => ({
          title: drill.name,
          description: (drill.steps || []).join(" "),
          evidence: drill.evidence,
        }))]
          .slice(0, 12)
          .map(
            (goal) => `
        <div class="goal">
          <strong>${escapeHtml(goal.title)}</strong>
          <p>${escapeHtml(goal.description)}</p>
          ${
            goal.evidence
              ? `<small>Evidence: "${escapeHtml(goal.evidence)}"</small>`
              : ""
          }
        </div>
      `
          )
          .join("")
      : emptyState("No action items found.");

  aiOutput.innerHTML =
    hasAnalysis
      ? `${renderDoneBanner(result.analysis)}${renderAnalysis(result.analysis)}`
      : `
        ${renderDoneBanner(result.analysis, "Transcript only")}
        <p><strong>Transcript ready:</strong> ${escapeHtml(result.analysis.summary)}</p>
        <p class="placeholder">No structured training plan came back. Check the transcript for audio quality, confirm Ollama is running, then retry.</p>
      `;
}

function startProcessingVisual(fileName) {
  stopProcessingVisual();

  const stages = [
    {
      title: "Extracting audio",
      detail: `Reading coach commentary from ${fileName}.`,
      percent: 22,
    },
    {
      title: "Transcribing coach audio",
      detail: "Local Whisper is creating timestamped transcript segments.",
      percent: 48,
    },
    {
      title: "Retrieving coaching fundamentals",
      detail: "RankUp is matching the transcript to League coaching notes.",
      percent: 68,
    },
    {
      title: "Building training plan",
      detail: "Ollama is organizing transcript-backed focus areas and goals.",
      percent: 86,
    },
  ];
  let stageIndex = 0;

  renderProgressCard(stages[stageIndex]);
  progressTimer = window.setInterval(() => {
    stageIndex = Math.min(stageIndex + 1, stages.length - 1);
    renderProgressCard(stages[stageIndex]);
  }, 2600);
}

function stopProcessingVisual() {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = null;
  }
}

function renderProgressCard(stage) {
  aiOutput.innerHTML = `
    <div class="analysis-state is-loading" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <div>
        <strong>${escapeHtml(stage.title)}</strong>
        <p>${escapeHtml(stage.detail)}</p>
      </div>
    </div>
    <div class="progress-meter" aria-label="Analysis progress">
      <span style="width: ${stage.percent}%"></span>
    </div>
  `;
}

function renderDoneBanner(analysis, labelOverride) {
  const mode = analysis.metadata && analysis.metadata.analysisMode;
  const usedFallback = typeof mode === "string" && mode.includes("local_grounded");
  const label =
    labelOverride ||
    (mode === "ollama"
      ? "Ollama analysis complete"
      : usedFallback
        ? "Transcript-grounded fallback complete"
        : "Analysis complete");
  const detail =
    usedFallback
      ? "Ollama did not return a usable structured plan in time. RankUp used direct transcript extraction so you still have review material."
      : "RankUp generated transcript-backed notes and action items.";

  return `
    <div class="analysis-state is-done">
      <div class="done-mark" aria-hidden="true">OK</div>
      <div>
        <strong>${escapeHtml(label)}</strong>
        <p>${escapeHtml(detail)}</p>
      </div>
    </div>
  `;
}

function hasStructuredReview(analysis) {
  return [
    analysis.reviewSections,
    analysis.importantConcepts,
    analysis.recurringMistakes,
    analysis.trainingGoals,
    analysis.drills,
    analysis.keyMoments,
  ].some((items) => Array.isArray(items) && items.length > 0);
}

function renderAnalysis(analysis) {
  const sections = analysis.reviewSections || [];
  const concepts = analysis.importantConcepts || [];
  const mistakes = analysis.recurringMistakes || [];
  const goals = analysis.trainingGoals || [];
  const drills = analysis.drills || [];
  const keyMoments = analysis.keyMoments || [];
  const confidence = analysis.metadata && analysis.metadata.confidence;

  return `
    <p><strong>Summary:</strong> ${escapeHtml(analysis.summary)}</p>
    ${
      confidence
        ? `<p><strong>Confidence:</strong> ${escapeHtml(confidence)}</p>`
        : ""
    }
    ${
      sections.length > 0
        ? `<p><strong>Review sections:</strong></p><ul>${sections
            .map(
              (section) =>
                `<li><strong>${escapeHtml(section.title)}:</strong> ${escapeHtml(section.takeaway)}${
                  section.evidence ? ` <em>"${escapeHtml(section.evidence)}"</em>` : ""
                }</li>`
            )
            .join("")}</ul>`
        : ""
    }
    ${
      concepts.length > 0
        ? `<p><strong>Focus areas:</strong></p><ul>${concepts
            .map(
              (concept) =>
                `<li><strong>${escapeHtml(concept.name)}:</strong> ${escapeHtml(concept.whyItMatters)}</li>`
            )
            .join("")}</ul>`
        : ""
    }
    ${
      goals.length > 0
        ? `<p><strong>Training goals:</strong></p><ul>${goals
            .map(
              (goal) =>
                `<li><strong>${escapeHtml(goal.title)}:</strong> ${escapeHtml(goal.description)}</li>`
            )
            .join("")}</ul>`
        : ""
    }
    ${
      drills.length > 0
        ? `<p><strong>Practice drills:</strong></p><ul>${drills
            .map(
              (drill) =>
                `<li><strong>${escapeHtml(drill.name)}:</strong> ${escapeHtml(
                  (drill.steps || []).join(" ")
                )}${drill.evidence ? ` <em>"${escapeHtml(drill.evidence)}"</em>` : ""}</li>`
            )
            .join("")}</ul>`
        : ""
    }
    ${
      keyMoments.length > 0
        ? `<p><strong>Key moments:</strong></p><ul>${keyMoments
            .slice(0, 4)
            .map(
              (moment) =>
                `<li><strong>${formatTime(moment.time)}:</strong> ${escapeHtml(moment.text)}</li>`
            )
            .join("")}</ul>`
        : ""
    }
  `;
}

function emptyState(message) {
  return `<div class="empty-state">${message}</div>`;
}

function setSelectedVod(file) {
  if (!file || !file.type.startsWith("video/")) {
    fileChip.textContent = "Please choose a video file";
    return;
  }

  selectedVod = file;
  resetReviewState();
  fileChip.textContent = `${file.name} selected`;
  pipelineStatus.textContent = "Uploaded";
  processVod.textContent = "Transcribe VOD";
  processVod.disabled = false;

  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
  }

  objectUrl = URL.createObjectURL(file);
  vodPreview.src = objectUrl;
  videoPreview.hidden = false;
}

function resetReviewState() {
  latestTranscript = "";
  document
    .querySelectorAll(".pipeline-step")
    .forEach((step) => step.classList.remove("complete", "processing"));
  timeline.innerHTML = emptyState("No transcript yet.");
  bars.innerHTML = emptyState("No excerpts yet.");
  goalList.innerHTML = emptyState("No action items yet.");
  fullTranscript.textContent = "No transcript yet.";
  aiOutput.innerHTML = `<p>Ready to transcribe the selected VOD.</p>`;
}

vodInput.addEventListener("change", (event) => {
  setSelectedVod(event.target.files[0]);
});

["dragenter", "dragover"].forEach((eventName) => {
  uploadStage.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadStage.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  uploadStage.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadStage.classList.remove("dragging");
  });
});

uploadStage.addEventListener("drop", (event) => {
  setSelectedVod(event.dataTransfer.files[0]);
});

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    navItems.forEach((navItem) => navItem.classList.remove("active"));
    item.classList.add("active");

    const target = document.querySelector(`#${item.dataset.target}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});

jumpButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.querySelector(`#${button.dataset.jump}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});

copyTranscript.addEventListener("click", async () => {
  if (!latestTranscript.trim()) {
    copyTranscript.textContent = "No Transcript";
    setTimeout(() => {
      copyTranscript.textContent = "Copy";
    }, 1200);
    return;
  }

  await navigator.clipboard.writeText(latestTranscript);
  copyTranscript.textContent = "Copied";
  setTimeout(() => {
    copyTranscript.textContent = "Copy";
  }, 1200);
});

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
