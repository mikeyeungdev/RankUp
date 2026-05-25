const annotations = [
  {
    time: "08:42",
    category: "positioning",
    note: "Trades without tracking enemy jungler after ward expires.",
  },
  {
    time: "14:05",
    category: "macro",
    note: "Stays mid after crashing wave instead of moving first to Herald.",
  },
  {
    time: "23:18",
    category: "objective",
    note: "Arrives late to dragon setup; team loses river control.",
  },
  {
    time: "29:51",
    category: "objective",
    note: "Walks into Baron river without blue trinket or frontline.",
  },
];

const mistakeData = [
  { label: "Objective Control", value: 42 },
  { label: "Positioning", value: 27 },
  { label: "Macro Rotations", value: 21 },
  { label: "Mechanical Execution", value: 10 },
];

const goals = [
  {
    title: "Objective countdown routine",
    text: "Ping timer, reset, and ward river 45 seconds before dragon or Baron.",
  },
  {
    title: "Mid priority check",
    text: "Before roaming, confirm wave state, jungler location, and side-lane setup.",
  },
  {
    title: "Death review rule",
    text: "For every death, label the first avoidable decision instead of the final misplay.",
  },
];

const timeline = document.querySelector("#timeline");
const bars = document.querySelector("#bars");
const goalList = document.querySelector("#goals");
const aiOutput = document.querySelector("#aiOutput");
const generateInsights = document.querySelector("#generateInsights");

timeline.innerHTML = annotations
  .map(
    (item) => `
      <div class="timestamp">
        <strong>${item.time}</strong>
        <span>${item.note}</span>
        <span class="tag ${item.category}">${item.category}</span>
      </div>
    `
  )
  .join("");

bars.innerHTML = mistakeData
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

generateInsights.addEventListener("click", () => {
  generateInsights.textContent = "Review Generated";
  aiOutput.innerHTML = `
    <p><strong>Summary:</strong> The largest pattern is not lane mechanics; it is arriving late to neutral-objective fights. The Ahri player often uses the first good wave state to farm one more wave instead of moving into river with tempo.</p>
    <p><strong>Repeated mistakes:</strong></p>
    <ul>
      <li>Objective setup starts after the enemy team already controls river.</li>
      <li>Roams are attempted without confirming jungle tracking or lane priority.</li>
      <li>Late-game deaths come from checking fog without vision tools.</li>
    </ul>
    <p><strong>Recommendation:</strong> Practice a 45-second objective routine: reset, buy control ward, move with jungler, then contest river vision before hitting mid wave again.</p>
  `;
});
