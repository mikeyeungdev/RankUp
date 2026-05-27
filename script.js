const pipelineSteps = [
  {
    label: "Upload VOD",
    detail: "Coach-reviewed League clip is stored with player, champion, and role metadata.",
  },
  {
    label: "Extract Audio",
    detail: "The app isolates the coach commentary track from the uploaded MP4.",
  },
  {
    label: "Transcribe",
    detail: "Speech-to-text returns timestamped coaching segments.",
  },
  {
    label: "Classify Concepts",
    detail: "AI tags each segment with League concepts and mistake categories.",
  },
  {
    label: "Generate Plan",
    detail: "RankUp summarizes patterns and creates focused training goals.",
  },
];

const transcriptMoments = [
  {
    time: "06:18",
    category: "wave",
    quote: "You crash this wave, but then you hover mid instead of using tempo to ward raptor entrance.",
  },
  {
    time: "11:44",
    category: "jungle",
    quote: "Before trading here, ask where Lee Sin can be. Your river ward expired twenty seconds ago.",
  },
  {
    time: "18:09",
    category: "objective",
    quote: "Dragon is spawning in forty-five. This reset has to happen now, not after one more wave.",
  },
  {
    time: "24:37",
    category: "positioning",
    quote: "Your job in this fight is to threaten charm from fog, not walk first into river.",
  },
];

const conceptData = [
  { label: "Objective Tempo", value: 38 },
  { label: "Wave Management", value: 24 },
  { label: "Jungle Tracking", value: 21 },
  { label: "Teamfight Positioning", value: 17 },
];

const goals = [
  {
    title: "45-second objective reset",
    text: "Recall, buy control ward, and move with jungler before every dragon or Baron setup.",
  },
  {
    title: "Wave into information",
    text: "After crashing mid wave, spend the next tempo window placing or clearing vision.",
  },
  {
    title: "Jungle location callout",
    text: "Before taking a trade, say the enemy jungler's likely quadrant out loud.",
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

timeline.innerHTML = transcriptMoments
  .map(
    (item) => `
      <div class="timestamp">
        <strong>${item.time}</strong>
        <span>${item.quote}</span>
        <span class="tag ${item.category}">${item.category}</span>
      </div>
    `
  )
  .join("");

bars.innerHTML = conceptData
  .map(
    (item) => `
      <div class="bar-row">
        <strong>${item.label}</strong>
        <div class="bar-track" aria-label="${item.label}: ${item.value}%">
          <div class="bar-fill" style="width: ${item.value}%"></div>
        </div>
        <span>${item.value}%</span>
      </div>
    `
  )
  .join("");

goalList.innerHTML = goals
  .map(
    (goal) => `
      <div class="goal">
        <strong>${goal.title}</strong>
        <p>${goal.text}</p>
      </div>
    `
  )
  .join("");

processVod.addEventListener("click", async () => {
  if (window.location.protocol === "file:") {
    aiOutput.innerHTML = `
      <p><strong>Server not connected:</strong> RankUp is open as a local HTML file.</p>
      <p class="placeholder">Start the app with <strong>npm run dev</strong>, then open <strong>http://localhost:3000</strong>. Upload processing cannot work from file://.</p>
    `;
    return;
  }

  if (!selectedVod) {
    fileChip.textContent = "Add a coached VOD before processing";
    uploadStage.classList.add("dragging");
    setTimeout(() => uploadStage.classList.remove("dragging"), 900);
    return;
  }

  processVod.disabled = true;
  processVod.textContent = "Processing...";
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
    processVod.textContent = "Analysis Complete";
    processVod.disabled = false;
    renderReviewResult(result);
  } catch (error) {
    steps.forEach((step) => step.classList.remove("processing"));
    pipelineStatus.textContent = "Needs Setup";
    processVod.textContent = "Process Coached VOD";
    processVod.disabled = false;
    aiOutput.innerHTML = `
      <p><strong>Processing failed:</strong> ${error.message}</p>
      <p class="placeholder">Make sure the page is opened at <strong>http://localhost:3000</strong>, the server is running with <strong>npm run dev</strong>, and <strong>OPENAI_API_KEY</strong> is set in your .env file.</p>
    `;
  }
});

function renderReviewResult(result) {
  const concepts = result.analysis.importantConcepts || [];
  const mistakes = result.analysis.recurringMistakes || [];
  const generatedGoals = result.analysis.trainingGoals || [];
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
    "No clear coach speech was detected. Try a VOD with louder coach audio, or set LOCAL_WHISPER_MODEL=base in .env for better accuracy.";

  bars.innerHTML = concepts
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
    .join("");

  goalList.innerHTML = generatedGoals
    .map(
      (goal) => `
        <div class="goal">
          <strong>${escapeHtml(goal.title)}</strong>
          <p>${escapeHtml(goal.description)}</p>
        </div>
      `
    )
    .join("");

  aiOutput.innerHTML = `
    <p><strong>Coach summary:</strong> ${escapeHtml(result.analysis.summary)}</p>
    <p><strong>Important concepts:</strong></p>
    <ul>
      ${concepts
        .map(
          (concept) =>
            `<li><strong>${escapeHtml(concept.name)}:</strong> ${escapeHtml(concept.whyItMatters)}</li>`
        )
        .join("")}
    </ul>
    <p><strong>Recurring mistakes:</strong></p>
    <ul>
      ${mistakes
        .map(
          (mistake) =>
            `<li><strong>${escapeHtml(mistake.mistake)}:</strong> ${escapeHtml(mistake.fix)}</li>`
        )
        .join("")}
    </ul>
  `;
}

function setSelectedVod(file) {
  if (!file || !file.type.startsWith("video/")) {
    fileChip.textContent = "Please choose a video file";
    return;
  }

  selectedVod = file;
  fileChip.textContent = `${file.name} selected`;
  pipelineStatus.textContent = "Uploaded";
  processVod.textContent = "Process Coached VOD";

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
