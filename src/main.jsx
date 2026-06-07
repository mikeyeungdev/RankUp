import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "../dashboard.css";

const pipelineSteps = [
  { label: "Upload VOD", detail: "Select the video file." },
  { label: "Extract Audio", detail: "Pull out the audio track." },
  { label: "Transcribe", detail: "Create timestamped text." },
  { label: "Build Plan", detail: "Create evidence-backed goals." },
];

function App() {
  const [route, setRoute] = useState(getRoute());

  useEffect(() => {
    const onPopState = () => setRoute(getRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigate(path) {
    window.history.pushState({}, "", path);
    setRoute(getRoute());
  }

  return (
    <main className="app">
      <AppHeader route={route} onNavigate={navigate} />
      {route === "dashboard" ? <Dashboard /> : <Analyzer />}
    </main>
  );
}

function AppHeader({ route, onNavigate }) {
  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand-mark">R</div>
        <div>
          <strong>RankUp</strong>
          <span>{route === "dashboard" ? "Review history dashboard" : "League coaching VOD analyzer"}</span>
        </div>
      </div>
      <nav className="top-nav" aria-label="RankUp navigation">
        <button
          className={`nav-link ${route === "analyzer" ? "active" : ""}`}
          type="button"
          onClick={() => onNavigate("/")}
        >
          Analyzer
        </button>
        <button
          className={`nav-link ${route === "dashboard" ? "active" : ""}`}
          type="button"
          onClick={() => onNavigate("/dashboard.html")}
        >
          Dashboard
        </button>
      </nav>
    </header>
  );
}

function Analyzer() {
  const [selectedVod, setSelectedVod] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [status, setStatus] = useState("Ready");
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pipelineIndex, setPipelineIndex] = useState(-1);
  const [review, setReview] = useState(null);
  const [error, setError] = useState("");
  const [progressStage, setProgressStage] = useState(null);

  const transcript = review ? review.transcript || "" : "";
  const segments = review ? review.segments || [] : [];
  const analysis = review ? review.analysis || {} : {};

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!isProcessing || !selectedVod) {
      return undefined;
    }

    const stages = [
      { title: "Extracting audio", detail: `Reading coach commentary from ${selectedVod.name}.`, percent: 22 },
      { title: "Transcribing coach audio", detail: "Local Whisper is creating timestamped transcript segments.", percent: 48 },
      { title: "Retrieving coaching fundamentals", detail: "RankUp is matching the transcript to League coaching notes.", percent: 68 },
      { title: "Building training plan", detail: "The LLM is organizing transcript-backed focus areas and goals.", percent: 86 },
    ];
    let stageIndex = 0;
    setProgressStage(stages[stageIndex]);
    const timer = window.setInterval(() => {
      stageIndex = Math.min(stageIndex + 1, stages.length - 1);
      setProgressStage(stages[stageIndex]);
    }, 2600);

    return () => window.clearInterval(timer);
  }, [isProcessing, selectedVod]);

  function setVod(file) {
    if (!file || !file.type.startsWith("video/")) {
      setStatus("Needs Video");
      return;
    }

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    setSelectedVod(file);
    setPreviewUrl(URL.createObjectURL(file));
    setReview(null);
    setError("");
    setPipelineIndex(-1);
    setStatus("Uploaded");
  }

  async function analyzeVod() {
    if (window.location.protocol === "file:") {
      setError("Start the app with npm run dev, then open http://localhost:3000.");
      return;
    }

    if (!selectedVod) {
      setStatus("Choose a VOD");
      return;
    }

    setIsProcessing(true);
    setStatus("Working");
    setError("");
    setReview(null);
    setPipelineIndex(0);

    const timer = window.setInterval(() => {
      setPipelineIndex((current) => Math.min(current + 1, pipelineSteps.length - 1));
    }, 520);

    try {
      const formData = new FormData();
      formData.append("vod", selectedVod);
      const response = await fetch("/api/reviews", { method: "POST", body: formData });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "VOD processing failed.");
      }

      setReview(result);
      setStatus("Analyzed");
      setPipelineIndex(pipelineSteps.length);
    } catch (requestError) {
      setError(requestError.message);
      setStatus("Needs Attention");
    } finally {
      window.clearInterval(timer);
      setIsProcessing(false);
      setProgressStage(null);
    }
  }

  async function loadLatest() {
    try {
      const response = await fetch("/api/reviews/latest");
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "No saved review found.");
      }

      setReview(result);
      setError(result.status === "failed" ? result.error : "");
      setStatus(result.status === "completed" ? "Loaded" : "Failed");
    } catch (requestError) {
      setError(requestError.message);
      setStatus("Needs Attention");
    }
  }

  async function clearSaved() {
    const response = await fetch("/api/reviews", { method: "DELETE" });
    const result = await response.json();
    setSelectedVod(null);
    setPreviewUrl("");
    setReview(null);
    setError(`Cleared ${result.deleted || 0} saved review file(s).`);
    setStatus("Ready");
    setPipelineIndex(-1);
  }

  async function copyTranscript() {
    if (!transcript.trim()) {
      return;
    }
    await navigator.clipboard.writeText(transcript);
  }

  return (
    <>
      <section className="hero" id="uploadSection">
        <div>
          <h1>Generate a training plan from coach audio.</h1>
          <p>
            Upload a League coaching VOD, extract the transcript, and turn the review into goals the student can act on.
          </p>
          <span className="status-pill">{status}</span>
        </div>
      </section>

      <section className="workspace-grid">
        <aside className="upload-card" aria-label="VOD upload">
          <PanelHeader eyebrow="Step 1" title="Upload VOD" />
          <label
            className={`upload-stage ${isDragging ? "dragging" : ""}`}
            htmlFor="vodInput"
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              event.preventDefault();
              setIsDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              setVod(event.dataTransfer.files[0]);
            }}
          >
            <input id="vodInput" type="file" accept="video/*" onChange={(event) => setVod(event.target.files[0])} />
            <span className="upload-icon">MP4</span>
            <strong>Choose or drop a VOD</strong>
            <span className="file-chip">{selectedVod ? `${selectedVod.name} selected` : "No file selected"}</span>
          </label>

          <div className="action-row">
            <button className="primary-action" type="button" disabled={isProcessing} onClick={analyzeVod}>
              {isProcessing ? "Analyzing..." : review ? "Analyze Another VOD" : "Analyze VOD"}
            </button>
            <button className="secondary-action" type="button" onClick={loadLatest}>
              Load Latest
            </button>
          </div>
          <button className="ghost-action" type="button" onClick={clearSaved}>
            Clear saved reviews
          </button>

          {previewUrl ? (
            <div className="video-preview">
              <video src={previewUrl} controls />
            </div>
          ) : null}

          <Pipeline currentIndex={pipelineIndex} />
        </aside>

        <section className="review-workspace" aria-label="Review output">
          <article className="panel status-panel">
            <PanelHeader eyebrow="Step 2" title="Training Plan" />
            <AnalysisOutput analysis={analysis} error={error} progressStage={progressStage} review={review} />
          </article>

          <article className="panel transcript-panel" id="transcriptSection">
            <PanelHeader
              eyebrow="Evidence"
              title="Timestamped Transcript"
              action={
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => document.querySelector("#fullTranscriptSection")?.scrollIntoView({ behavior: "smooth" })}
                >
                  Full Transcript
                </button>
              }
            />
            <Timeline segments={segments} />
          </article>
        </section>
      </section>

      <section className="panel full-transcript-card" id="fullTranscriptSection">
        <PanelHeader
          eyebrow="Full Transcript"
          title="Raw text from the video"
          action={
            <button className="secondary-action" type="button" onClick={copyTranscript}>
              Copy Transcript
            </button>
          }
        />
        <pre>{transcript.trim() || "No transcript yet."}</pre>
      </section>
    </>
  );
}

function Dashboard() {
  const [dashboard, setDashboard] = useState(null);
  const [selectedReview, setSelectedReview] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    loadDashboard();
  }, []);

  async function loadDashboard() {
    try {
      const response = await fetch("/api/dashboard");
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Dashboard could not load.");
      }
      setDashboard(result);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function openReview(reviewId) {
    const response = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}`);
    const result = await response.json();
    setSelectedReview(response.ok ? result : { error: result.error || "Could not load review." });
  }

  const totals = dashboard?.totals || {};
  const recommendedGoals = dashboard?.recommendedGoals || [];

  return (
    <>
      <section className="hero dashboard-hero">
        <div>
          <h1>Manage student goals from past VOD reviews.</h1>
          <p>Track recommended training goals, revisit full reviews, and keep coach notes tied to the transcript evidence.</p>
        </div>
        <span className="status-pill">{dashboard?.source === "postgres" ? "PostgreSQL" : "Local JSON"}</span>
      </section>

      <section className="metric-grid" aria-label="Review metrics">
        {error ? (
          <EmptyState message={`Dashboard failed: ${error}`} />
        ) : (
          <>
            <MetricCard label="Total Reviews" value={totals.total_reviews || 0} />
            <MetricCard label="Ollama Runs" value={totals.ollama_reviews || 0} />
            <MetricCard label="Open Goals" value={countOpenGoals(recommendedGoals)} />
            <MetricCard label="Last Review" value={formatDate(totals.last_review_at)} />
          </>
        )}
      </section>

      <section className="dashboard-shell">
        <section className="panel goals-panel">
          <PanelHeader eyebrow="Active Work" title="Recommended Training Goals" />
          <div className="dashboard-list">
            {recommendedGoals.length ? recommendedGoals.map((goal) => <GoalCard key={goal.id} goal={goal} onSave={loadDashboard} />) : <EmptyState message="No recommended goals yet." />}
          </div>
        </section>

        <aside className="dashboard-sidebar">
          <section className="panel">
            <PanelHeader eyebrow="Patterns" title="Repeated Focus Areas" />
            <div className="dashboard-list">
              {(dashboard?.topFocusAreas || []).length ? (
                dashboard.topFocusAreas.map((item) => <PatternCard key={item.name} item={item} />)
              ) : (
                <EmptyState message="No repeated focus areas yet." />
              )}
            </div>
          </section>

          <section className="panel history-panel">
            <PanelHeader eyebrow="History" title="Previous Reviews" />
            <div className="review-table">
              {(dashboard?.recentReviews || []).length ? (
                dashboard.recentReviews.map((review) => (
                  <ReviewRow key={review.id} review={review} onOpen={() => openReview(review.id)} />
                ))
              ) : (
                <EmptyState message="No reviews saved yet." />
              )}
            </div>
          </section>
        </aside>
      </section>

      {selectedReview ? <ReviewDetail review={selectedReview} onClose={() => setSelectedReview(null)} /> : null}
    </>
  );
}

function GoalCard({ goal, onSave }) {
  const [edit, setEdit] = useState(() => readGoalEdit(goal));
  const [saveState, setSaveState] = useState("");
  const status = edit.status || goal.status || "active";
  const note = edit.note ?? goal.coach_note ?? "";

  async function saveGoal() {
    const updated = { ...edit, status, note, updatedAt: new Date().toISOString() };
    setSaveState("Saving...");

    try {
      const response = await fetch(`/api/goals/${encodeURIComponent(goal.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, coachNote: note }),
      });
      const savedGoal = await response.json();

      if (!response.ok) {
        throw new Error(savedGoal.error || "Goal edit was not saved to PostgreSQL.");
      }

      localStorage.removeItem(goalStorageKey(goal.id));
      setEdit({
        status: savedGoal.status,
        note: savedGoal.coach_note || "",
        updatedAt: savedGoal.updated_at,
      });
      setSaveState("Saved to PostgreSQL");
      onSave();
    } catch (error) {
      localStorage.setItem(goalStorageKey(goal.id), JSON.stringify(updated));
      setEdit(updated);
      setSaveState("Saved locally");
    }
  }

  return (
    <article className="goal-card">
      <div className="goal-summary">
        <div className="goal-title-row">
          <span className={`goal-status ${status}`}>{status}</span>
          <small>{goal.file_name || "Review"} - {formatDate(goal.created_at)}</small>
        </div>
        <h3>{goal.title || "Training goal"}</h3>
        <p>{goal.description || ""}</p>
        {goal.evidence ? <blockquote>Evidence: "{goal.evidence}"</blockquote> : null}
        {note ? (
          <div className="saved-note">
            <strong>Coach note</strong>
            <p>{note}</p>
          </div>
        ) : null}
      </div>
      <details className="goal-editor">
        <summary>Edit goal</summary>
        <div className="goal-editor-body">
          <div className="status-control" role="radiogroup" aria-label="Goal status">
            {["active", "completed", "paused"].map((option) => (
              <button
                className={`status-choice ${status === option ? "selected" : ""}`}
                key={option}
                type="button"
                role="radio"
                aria-checked={status === option}
                onClick={() => setEdit((current) => ({ ...current, status: option }))}
              >
                {option}
              </button>
            ))}
          </div>
          <textarea
            value={note}
            onChange={(event) => setEdit((current) => ({ ...current, note: event.target.value }))}
            placeholder="Add a coaching note or next check-in"
          />
          <div className="goal-editor-actions">
            <small>{saveState || (edit.updatedAt ? `Saved ${formatDate(edit.updatedAt)}` : "")}</small>
            <button className="secondary-action" type="button" onClick={saveGoal}>
              Save changes
            </button>
          </div>
        </div>
      </details>
    </article>
  );
}

function AnalysisOutput({ analysis, error, progressStage, review }) {
  if (progressStage) {
    return (
      <div className="ai-output">
        <div className="analysis-state is-loading" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <div>
            <strong>{progressStage.title}</strong>
            <p>{progressStage.detail}</p>
          </div>
        </div>
        <div className="progress-meter" aria-label="Analysis progress">
          <span style={{ width: `${progressStage.percent}%` }} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ai-output">
        <p><strong>Processing failed:</strong> {error}</p>
      </div>
    );
  }

  if (!review) {
    return <div className="ai-output"><p>Notes will appear after transcription.</p></div>;
  }

  const hasAnalysis = hasStructuredReview(analysis);

  return (
    <div className="ai-output">
      <DoneBanner analysis={analysis} labelOverride={hasAnalysis ? "" : "Transcript only"} />
      <p><strong>Summary:</strong> {analysis.summary}</p>
      {review.processing?.processingMs ? (
        <p><strong>Processed in:</strong> {formatDuration(review.processing.processingMs)}</p>
      ) : null}
      {analysis.metadata?.confidence ? <p><strong>Confidence:</strong> {analysis.metadata.confidence}</p> : null}
      <AnalysisList title="Review sections" items={analysis.reviewSections} getTitle={(item) => item.title} getText={(item) => item.takeaway} />
      <AnalysisList title="Focus areas" items={analysis.importantConcepts} getTitle={(item) => item.name} getText={(item) => item.whyItMatters} />
      <AnalysisList title="Training goals" items={analysis.trainingGoals} getTitle={(item) => item.title} getText={(item) => item.description} />
      <AnalysisList title="Key moments" items={(analysis.keyMoments || []).slice(0, 4)} getTitle={(item) => formatTime(item.time)} getText={(item) => item.text} />
    </div>
  );
}

function DoneBanner({ analysis, labelOverride }) {
  const mode = analysis.metadata?.analysisMode;
  const usedFallback = typeof mode === "string" && mode.includes("local_grounded");
  const label = labelOverride || (mode === "ollama" ? "Ollama analysis complete" : usedFallback ? "Transcript-grounded fallback complete" : "Analysis complete");
  const detail = usedFallback
    ? "RankUp used direct transcript extraction so you still have review material."
    : "RankUp generated transcript-backed notes and action items.";

  return (
    <div className="analysis-state is-done">
      <div className="done-mark" aria-hidden="true">OK</div>
      <div>
        <strong>{label}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function AnalysisList({ title, items = [], getTitle, getText }) {
  if (!items.length) {
    return null;
  }

  return (
    <>
      <p><strong>{title}:</strong></p>
      <ul>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>
            <strong>{getTitle(item)}:</strong> {getText(item)}
          </li>
        ))}
      </ul>
    </>
  );
}

function Timeline({ segments }) {
  if (!segments.length) {
    return <div className="timestamp"><strong>0:00</strong><span>No transcript yet.</span><span className="tag transcript">audio</span></div>;
  }

  return (
    <div className="timeline">
      {segments.map((segment, index) => (
        <div className="timestamp" key={`${segment.start}-${index}`}>
          <strong>{formatTime(segment.start)}</strong>
          <span>{segment.text}</span>
          <span className="tag transcript">audio</span>
        </div>
      ))}
    </div>
  );
}

function Pipeline({ currentIndex }) {
  return (
    <div className="pipeline" aria-label="Processing steps">
      {pipelineSteps.map((step, index) => (
        <div
          className={`pipeline-step ${currentIndex > index ? "complete" : ""} ${currentIndex === index ? "processing" : ""}`}
          key={step.label}
        >
          <span>{index + 1}</span>
          <div>
            <strong>{step.label}</strong>
            <p>{step.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReviewDetail({ review, onClose }) {
  if (review.error) {
    return (
      <section className="panel review-detail-panel">
        <PanelHeader eyebrow="Selected Review" title="Review not found" action={<button className="secondary-action" type="button" onClick={onClose}>Close</button>} />
        <p>{review.error}</p>
      </section>
    );
  }

  const analysis = review.analysis || {};
  return (
    <section className="panel review-detail-panel">
      <PanelHeader eyebrow="Selected Review" title={review.fileName || "Review"} action={<button className="secondary-action" type="button" onClick={onClose}>Close</button>} />
      <div className="review-detail">
        <p><strong>Summary:</strong> {analysis.summary || ""}</p>
        <ReviewSection title="Focus Areas" items={analysis.importantConcepts} getTitle={(item) => item.name} getText={(item) => item.whyItMatters} />
        <ReviewSection title="Training Goals" items={analysis.trainingGoals} getTitle={(item) => item.title} getText={(item) => item.description} />
        <ReviewSection title="Key Moments" items={analysis.keyMoments} getTitle={(item) => formatTime(item.time)} getText={(item) => item.text} />
        <details>
          <summary>Full Transcript</summary>
          <pre>{review.transcript || "No transcript saved."}</pre>
        </details>
      </div>
    </section>
  );
}

function ReviewSection({ title, items = [], getTitle, getText }) {
  if (!items.length) {
    return null;
  }

  return (
    <div className="review-detail-section">
      <h3>{title}</h3>
      {items.slice(0, 8).map((item, index) => (
        <article className="dashboard-item" key={`${title}-${index}`}>
          <strong>{getTitle(item) || ""}</strong>
          <p>{getText(item) || ""}</p>
        </article>
      ))}
    </div>
  );
}

function ReviewRow({ review, onOpen }) {
  return (
    <article className="review-row">
      <div>
        <strong>{review.file_name || review.fileName || "Untitled review"}</strong>
        <p>{review.analysis_summary || review.analysisSummary || ""}</p>
      </div>
      <div className="review-meta">
        <small>{formatDate(review.created_at || review.createdAt)}</small>
        <small>{review.analysis_mode || review.analysisMode || "unknown"}</small>
        {review.processing_ms || review.processingMs ? (
          <small>{formatDuration(review.processing_ms || review.processingMs)}</small>
        ) : null}
      </div>
      <button className="secondary-action" type="button" onClick={onOpen}>View Review</button>
    </article>
  );
}

function PatternCard({ item }) {
  return (
    <article className="dashboard-item">
      <header>
        <strong>{item.name || "Focus area"}</strong>
        <span className="count-pill">{Number(item.count || 1)}</span>
      </header>
      <p>{item.category || "review_note"}</p>
    </article>
  );
}

function MetricCard({ label, value }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function PanelHeader({ eyebrow, title, action }) {
  return (
    <div className="panel-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

function EmptyState({ message }) {
  return <div className="empty-state">{message}</div>;
}

function hasStructuredReview(analysis = {}) {
  return [
    analysis.reviewSections,
    analysis.importantConcepts,
    analysis.recurringMistakes,
    analysis.trainingGoals,
    analysis.drills,
    analysis.keyMoments,
  ].some((items) => Array.isArray(items) && items.length > 0);
}

function readGoalEdit(goal) {
  try {
    const localEdit = JSON.parse(localStorage.getItem(goalStorageKey(goal.id)) || "{}");
    return {
      status: goal.status || "active",
      note: goal.coach_note || "",
      updatedAt: goal.updated_at || "",
      ...localEdit,
    };
  } catch (_error) {
    return {
      status: goal.status || "active",
      note: goal.coach_note || "",
      updatedAt: goal.updated_at || "",
    };
  }
}

function countOpenGoals(items) {
  return items.filter((goal) => {
    const edit = readGoalEdit(goal);
    return (edit.status || goal.status || "active") === "active";
  }).length;
}

function goalStorageKey(goalId) {
  return `rankup_goal_${goalId}`;
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

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function getRoute() {
  return window.location.pathname.includes("dashboard") ? "dashboard" : "analyzer";
}

createRoot(document.getElementById("root")).render(<App />);
