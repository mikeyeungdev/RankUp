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
  processVod.textContent = "Transcribing...";
  pipelineStatus.textContent = "Working";
  aiOutput.innerHTML = `<p class="placeholder">Extracting audio from ${selectedVod.name}...</p>`;

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

    steps.forEach((step) => step.classList.add("complete"));
    steps.forEach((step) => step.classList.remove("processing"));
    pipelineStatus.textContent = "Analyzed";
    processVod.textContent = "Transcription Complete";
    processVod.disabled = false;
    renderReviewResult(result);
  } catch (error) {
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

function renderReviewResult(result) {
  const concepts = result.analysis.importantConcepts || [];
  const mistakes = result.analysis.recurringMistakes || [];
  const generatedGoals = result.analysis.trainingGoals || [];
  const keyMoments = result.analysis.keyMoments || [];
  const segments = result.segments || [];
  latestTranscript = result.transcript || "";

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
    concepts.length > 0
      ? concepts
          .map((concept, index) => {
            const value = Math.max(8, Math.min(100, Math.round(concept.frequency || 20)));
            return `
        <div class="bar-row">
          <strong>${escapeHtml(concept.name)}</strong>
          <div class="bar-track" aria-label="${escapeHtml(concept.name)}: ${value}%">
            <div class="bar-fill" style="width: ${value}%"></div>
          </div>
          <span>${index + 1}</span>
        </div>
      `;
          })
          .join("")
      : emptyState("No excerpts found.");

  goalList.innerHTML =
    generatedGoals.length > 0
      ? generatedGoals
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
    concepts.length > 0 || mistakes.length > 0 || generatedGoals.length > 0 || keyMoments.length > 0
      ? renderAnalysis(result.analysis)
      : `
        <p><strong>Transcript ready:</strong> ${escapeHtml(result.analysis.summary)}</p>
        <p class="placeholder">Check the transcript for audio quality, then retry with Ollama running.</p>
      `;
}

function renderAnalysis(analysis) {
  const concepts = analysis.importantConcepts || [];
  const mistakes = analysis.recurringMistakes || [];
  const goals = analysis.trainingGoals || [];
  const keyMoments = analysis.keyMoments || [];

  return `
    <p><strong>Summary:</strong> ${escapeHtml(analysis.summary)}</p>
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
  fileChip.textContent = `${file.name} selected`;
  pipelineStatus.textContent = "Uploaded";
  processVod.textContent = "Transcribe VOD";

  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
  }

  objectUrl = URL.createObjectURL(file);
  vodPreview.src = objectUrl;
  videoPreview.hidden = false;
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
