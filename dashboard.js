const metricGrid = document.querySelector("#metricGrid");
const focusAreas = document.querySelector("#focusAreas");
const goals = document.querySelector("#goals");
const recentReviews = document.querySelector("#recentReviews");
const dataSource = document.querySelector("#dataSource");
const reviewDetail = document.querySelector("#reviewDetail");
const reviewDetailTitle = document.querySelector("#reviewDetailTitle");
const reviewDetailBody = document.querySelector("#reviewDetailBody");
const closeReviewDetail = document.querySelector("#closeReviewDetail");

let dashboardState = null;

loadDashboard();

async function loadDashboard() {
  try {
    const response = await fetch("/api/dashboard");
    const dashboard = await response.json();

    if (!response.ok) {
      throw new Error(dashboard.error || "Dashboard could not load.");
    }

    dashboardState = dashboard;
    renderDashboard(dashboard);
  } catch (error) {
    metricGrid.innerHTML = emptyState(`Dashboard failed: ${error.message}`);
  }
}

function renderDashboard(dashboard) {
  const totals = dashboard.totals || {};
  const recommendedGoals = dashboard.recommendedGoals || [];
  dataSource.textContent = dashboard.source === "postgres" ? "PostgreSQL" : "Local JSON";

  metricGrid.innerHTML = [
    metricCard("Total Reviews", totals.total_reviews || 0),
    metricCard("Ollama Runs", totals.ollama_reviews || 0),
    metricCard("Open Goals", countOpenGoals(recommendedGoals)),
    metricCard("Last Review", formatDate(totals.last_review_at)),
  ].join("");

  goals.innerHTML = renderGoals(recommendedGoals);
  focusAreas.innerHTML = renderPatterns(dashboard.topFocusAreas || []);
  recentReviews.innerHTML = renderRecentReviews(dashboard.recentReviews || []);
}

function metricCard(label, value) {
  return `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function renderGoals(items = []) {
  if (!items.length) {
    return emptyState("No recommended goals yet.");
  }

  return items
    .map((goal) => {
      const edit = readGoalEdit(goal.id);
      const status = edit.status || goal.status || "active";
      const note = edit.note || "";
      const savedLabel = edit.updatedAt ? `Saved ${formatDate(edit.updatedAt)}` : "";

      return `
        <article class="goal-card" data-goal-id="${escapeHtml(goal.id)}">
          <div class="goal-summary">
            <div class="goal-title-row">
              <span class="goal-status ${escapeHtml(status)}">${escapeHtml(status)}</span>
              <small>${escapeHtml(goal.file_name || "Review")} - ${escapeHtml(formatDate(goal.created_at))}</small>
            </div>
            <h3>${escapeHtml(goal.title || "Training goal")}</h3>
            <p>${escapeHtml(goal.description || "")}</p>
            ${
              goal.evidence
                ? `<blockquote>Evidence: "${escapeHtml(goal.evidence)}"</blockquote>`
                : ""
            }
            ${
              note
                ? `<div class="saved-note"><strong>Coach note</strong><p>${escapeHtml(note)}</p></div>`
                : ""
            }
          </div>
          <details class="goal-editor">
            <summary>Edit goal</summary>
            <div class="goal-editor-body">
              <div class="status-control" role="radiogroup" aria-label="Goal status">
                ${["active", "completed", "paused"]
                  .map(
                    (option) => `
                      <button
                        class="status-choice ${option === status ? "selected" : ""}"
                        type="button"
                        role="radio"
                        aria-checked="${option === status}"
                        data-status-choice="${escapeHtml(goal.id)}"
                        data-status-value="${option}"
                      >
                        ${option}
                      </button>
                    `
                  )
                  .join("")}
              </div>
              <textarea data-goal-note="${escapeHtml(goal.id)}" placeholder="Add a coaching note or next check-in">${escapeHtml(
                note
              )}</textarea>
              <div class="goal-editor-actions">
                <small>${escapeHtml(savedLabel)}</small>
                <button class="secondary-action" type="button" data-save-goal="${escapeHtml(goal.id)}">Save changes</button>
              </div>
            </div>
          </details>
        </article>
      `;
    })
    .join("");
}

function renderPatterns(items = []) {
  if (!items.length) {
    return emptyState("No repeated focus areas yet.");
  }

  return items
    .map(
      (item) => `
        <article class="dashboard-item">
          <header>
            <strong>${escapeHtml(item.name || "Focus area")}</strong>
            <span class="count-pill">${Number(item.count || 1)}</span>
          </header>
          <p>${escapeHtml(item.category || "review_note")}</p>
        </article>
      `
    )
    .join("");
}

function renderRecentReviews(items) {
  if (!items.length) {
    return emptyState("No reviews saved yet.");
  }

  return items
    .map(
      (item) => `
        <article class="review-row">
          <div>
            <strong>${escapeHtml(item.file_name || item.fileName || "Untitled review")}</strong>
            <p>${escapeHtml(item.analysis_summary || item.analysisSummary || "")}</p>
          </div>
          <div class="review-meta">
            <small>${escapeHtml(formatDate(item.created_at || item.createdAt))}</small>
            <small>${escapeHtml(item.analysis_mode || item.analysisMode || "unknown")}</small>
          </div>
          <button class="secondary-action" type="button" data-open-review="${escapeHtml(item.id)}">View Review</button>
        </article>
      `
    )
    .join("");
}

document.addEventListener("click", async (event) => {
  const saveGoalId = event.target.dataset.saveGoal;
  const statusGoalId = event.target.dataset.statusChoice;
  const reviewId = event.target.dataset.openReview;

  if (statusGoalId) {
    updateGoalStatus(statusGoalId, event.target.dataset.statusValue);
  }

  if (saveGoalId) {
    saveGoalEdit(saveGoalId);
    renderDashboard(dashboardState);
  }

  if (reviewId) {
    await openReview(reviewId);
  }
});

closeReviewDetail.addEventListener("click", () => {
  reviewDetail.hidden = true;
});

async function openReview(reviewId) {
  const response = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}`);
  const review = await response.json();

  if (!response.ok) {
    reviewDetail.hidden = false;
    reviewDetailTitle.textContent = "Review not found";
    reviewDetailBody.innerHTML = `<p>${escapeHtml(review.error || "Could not load review.")}</p>`;
    return;
  }

  const analysis = review.analysis || {};
  reviewDetail.hidden = false;
  reviewDetailTitle.textContent = review.fileName || "Review";
  reviewDetailBody.innerHTML = `
    <p><strong>Summary:</strong> ${escapeHtml(analysis.summary || "")}</p>
    ${renderReviewSection("Focus Areas", analysis.importantConcepts, (item) => item.name, (item) => item.whyItMatters)}
    ${renderReviewSection("Training Goals", analysis.trainingGoals, (item) => item.title, (item) => item.description)}
    ${renderReviewSection("Key Moments", analysis.keyMoments, (item) => formatTime(item.time), (item) => item.text)}
    <details>
      <summary>Full Transcript</summary>
      <pre>${escapeHtml(review.transcript || "No transcript saved.")}</pre>
    </details>
  `;
  reviewDetail.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderReviewSection(title, items = [], titleFn, detailFn) {
  if (!items.length) {
    return "";
  }

  return `
    <div class="review-detail-section">
      <h3>${escapeHtml(title)}</h3>
      ${items
        .slice(0, 8)
        .map(
          (item) => `
            <article class="dashboard-item">
              <strong>${escapeHtml(titleFn(item) || "")}</strong>
              <p>${escapeHtml(detailFn(item) || "")}</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function saveGoalEdit(goalId) {
  const selectedStatus = document.querySelector(
    `[data-status-choice="${cssEscape(goalId)}"].selected`
  );
  const status = selectedStatus ? selectedStatus.dataset.statusValue : "active";
  const note = document.querySelector(`[data-goal-note="${cssEscape(goalId)}"]`).value.trim();
  localStorage.setItem(
    goalStorageKey(goalId),
    JSON.stringify({ status, note, updatedAt: new Date().toISOString() })
  );
}

function updateGoalStatus(goalId, status) {
  document
    .querySelectorAll(`[data-status-choice="${cssEscape(goalId)}"]`)
    .forEach((button) => {
      const isSelected = button.dataset.statusValue === status;
      button.classList.toggle("selected", isSelected);
      button.setAttribute("aria-checked", String(isSelected));
    });
}

function readGoalEdit(goalId) {
  try {
    return JSON.parse(localStorage.getItem(goalStorageKey(goalId)) || "{}");
  } catch (_error) {
    return {};
  }
}

function countOpenGoals(items) {
  return items.filter((goal) => {
    const edit = readGoalEdit(goal.id);
    return (edit.status || goal.status || "active") === "active";
  }).length;
}

function goalStorageKey(goalId) {
  return `rankup_goal_${goalId}`;
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function formatDate(value) {
  if (!value) {
    return "None";
  }

  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatTime(seconds) {
  const minutes = Math.floor(Number(seconds) / 60);
  const remainder = Math.round(Number(seconds) % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function cssEscape(value) {
  return String(value).replaceAll('"', '\\"');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
