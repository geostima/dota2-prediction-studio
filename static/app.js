const state = {
  heroes: [],
  players: [],
};

const sampleData = {
  radiantTeam: "Nemiga Gaming",
  direTeam: "IC x Insanity",
  radiantPlayers: ["byun", "young G", "hotoke", "CoviSnine", "ariel"],
  direPlayers: ["Rubikon155", "dualrazee", "Norma", "Fernans", "Kidaro"],
  radiantHeroes: ["Shadow Fiend", "Ember Spirit", "Tidehunter", "Keeper of the Light", "Clockwerk"],
  direHeroes: ["Rubick", "Earth Spirit", "Pangolier", "Dark Willow", "Winter Wyvern"],
};

function createRows(side) {
  const container = document.getElementById(`${side}Rows`);
  container.innerHTML = "";

  for (let i = 0; i < 5; i += 1) {
    const row = document.createElement("div");
    row.className = "row";

    const playerLabel = document.createElement("label");
    playerLabel.textContent = `Player ${i + 1}`;
    const playerInput = document.createElement("input");
    playerInput.id = `${side}Player${i}`;
    playerInput.placeholder = "Pro player name";
    playerInput.setAttribute("list", "playerSuggestions");
    playerLabel.appendChild(playerInput);

    const heroLabel = document.createElement("label");
    heroLabel.textContent = `Hero ${i + 1}`;
    const heroInput = document.createElement("input");
    heroInput.id = `${side}Hero${i}`;
    heroInput.placeholder = "Hero name";
    heroInput.setAttribute("list", "heroSuggestions");
    heroLabel.appendChild(heroInput);

    row.appendChild(playerLabel);
    row.appendChild(heroLabel);
    container.appendChild(row);
  }
}

function getTeamInputs(side) {
  const players = [];
  const heroes = [];
  for (let i = 0; i < 5; i += 1) {
    players.push(document.getElementById(`${side}Player${i}`).value.trim());
    heroes.push(document.getElementById(`${side}Hero${i}`).value.trim());
  }
  return { players, heroes };
}

function setStatusText(text) {
  document.getElementById("statusText").textContent = text;
}

function renderMetrics(metrics) {
  const box = document.getElementById("metricsBox");
  box.innerHTML = "";

  if (!metrics || Object.keys(metrics).length === 0) {
    return;
  }

  const rows = [];
  if (metrics.status) rows.push(`status: ${metrics.status}`);
  if (metrics.total_rows !== undefined) rows.push(`rows: ${metrics.total_rows}`);
  if (metrics.accuracy !== undefined) rows.push(`accuracy: ${(metrics.accuracy * 100).toFixed(2)}%`);
  if (metrics.roc_auc !== undefined && metrics.roc_auc !== null) rows.push(`roc_auc: ${metrics.roc_auc.toFixed(4)}`);
  if (metrics.log_loss !== undefined) rows.push(`log_loss: ${metrics.log_loss.toFixed(4)}`);
  if (metrics.brier !== undefined) rows.push(`brier: ${metrics.brier.toFixed(4)}`);
  if (metrics.reason) rows.push(`reason: ${metrics.reason}`);

  rows.forEach((line) => {
    const chip = document.createElement("div");
    chip.className = "metric-chip";
    chip.textContent = line;
    box.appendChild(chip);
  });
}

function renderPrediction(payload) {
  const { radiant_team: radiantTeam, dire_team: direTeam, prediction } = payload;
  const radiantProb = prediction.radiant_win_prob;
  const direProb = prediction.dire_win_prob;

  const resultPlaceholder = document.getElementById("resultPlaceholder");
  const resultContent = document.getElementById("resultContent");

  const winner = radiantProb >= direProb ? radiantTeam : direTeam;
  const winnerPct = Math.max(radiantProb, direProb).toFixed(2);

  resultContent.innerHTML = `
    <div class="winner-line">Likely winner: ${winner} (${winnerPct}%)</div>
    <div class="bars">
      <div>
        <div class="bar-label"><span>${radiantTeam}</span><span>${radiantProb.toFixed(2)}%</span></div>
        <div class="bar-track"><div class="bar-fill radiant" style="width:${radiantProb}%"></div></div>
      </div>
      <div>
        <div class="bar-label"><span>${direTeam}</span><span>${direProb.toFixed(2)}%</span></div>
        <div class="bar-track"><div class="bar-fill dire" style="width:${direProb}%"></div></div>
      </div>
      <div>
        <div class="bar-label"><span>${radiantTeam} comfort</span><span>${prediction.radiant_comfort.toFixed(2)}%</span></div>
        <div class="bar-track"><div class="bar-fill radiant" style="width:${prediction.radiant_comfort}%"></div></div>
      </div>
      <div>
        <div class="bar-label"><span>${direTeam} comfort</span><span>${prediction.dire_comfort.toFixed(2)}%</span></div>
        <div class="bar-track"><div class="bar-fill dire" style="width:${prediction.dire_comfort}%"></div></div>
      </div>
    </div>
    <div class="note" id="unresolvedNote"></div>
  `;

  const unresolved = prediction.unresolved_players || [];
  if (unresolved.length > 0) {
    document.getElementById("unresolvedNote").textContent =
      `Fallback baseline used for unresolved players: ${unresolved.join(", ")}`;
  }

  resultPlaceholder.classList.add("hidden");
  resultContent.classList.remove("hidden");
}

async function loadOptions() {
  const response = await fetch("/api/options");
  const data = await response.json();

  state.heroes = data.heroes || [];
  state.players = data.players || [];

  const heroDatalist = document.getElementById("heroSuggestions");
  const playerDatalist = document.getElementById("playerSuggestions");
  heroDatalist.innerHTML = "";
  playerDatalist.innerHTML = "";

  state.heroes.forEach((hero) => {
    const option = document.createElement("option");
    option.value = hero;
    heroDatalist.appendChild(option);
  });

  state.players.forEach((player) => {
    const option = document.createElement("option");
    option.value = player;
    playerDatalist.appendChild(option);
  });
}

async function loadStatus() {
  const response = await fetch("/api/status");
  const data = await response.json();

  const base = `Model ready: ${data.ready ? "yes" : "no"} | heroes: ${data.hero_count} | players: ${data.player_count}`;
  const message = data.last_error ? `${base} | warning: ${data.last_error}` : base;
  setStatusText(message);
  renderMetrics(data.metrics || {});
}

async function trainModel() {
  const trainBtn = document.getElementById("trainBtn");
  trainBtn.disabled = true;
  trainBtn.textContent = "Training...";

  try {
    const payload = {
      refresh_data: true,
      match_limit: Number(document.getElementById("matchLimit").value || 500),
      min_matches: Number(document.getElementById("minMatches").value || 120),
    };

    const response = await fetch("/api/train", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      setStatusText(`Training failed: ${data.last_error || "unknown error"}`);
    } else {
      setStatusText("Training complete. Model is ready for predictions.");
    }

    renderMetrics(data.metrics || {});
  } catch (error) {
    setStatusText(`Training request failed: ${error.message}`);
  } finally {
    trainBtn.disabled = false;
    trainBtn.textContent = "Refresh Data + Retrain";
    await loadStatus();
  }
}

async function runPrediction() {
  const predictBtn = document.getElementById("predictBtn");
  predictBtn.disabled = true;
  predictBtn.textContent = "Predicting...";

  try {
    const radiant = getTeamInputs("radiant");
    const dire = getTeamInputs("dire");

    const payload = {
      radiant_team: document.getElementById("radiantTeam").value.trim(),
      dire_team: document.getElementById("direTeam").value.trim(),
      radiant_players: radiant.players,
      dire_players: dire.players,
      radiant_heroes: radiant.heroes,
      dire_heroes: dire.heroes,
    };

    const response = await fetch("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || data.last_error || "Prediction failed");
    }

    renderPrediction(data);
  } catch (error) {
    const resultPlaceholder = document.getElementById("resultPlaceholder");
    const resultContent = document.getElementById("resultContent");
    resultPlaceholder.textContent = `Prediction error: ${error.message}`;
    resultPlaceholder.classList.remove("hidden");
    resultContent.classList.add("hidden");
  } finally {
    predictBtn.disabled = false;
    predictBtn.textContent = "Generate Prediction";
  }
}

function loadSampleData() {
  document.getElementById("radiantTeam").value = sampleData.radiantTeam;
  document.getElementById("direTeam").value = sampleData.direTeam;

  for (let i = 0; i < 5; i += 1) {
    document.getElementById(`radiantPlayer${i}`).value = sampleData.radiantPlayers[i];
    document.getElementById(`direPlayer${i}`).value = sampleData.direPlayers[i];
    document.getElementById(`radiantHero${i}`).value = sampleData.radiantHeroes[i];
    document.getElementById(`direHero${i}`).value = sampleData.direHeroes[i];
  }
}

async function initPage() {
  createRows("radiant");
  createRows("dire");
  loadSampleData();

  document.getElementById("sampleBtn").addEventListener("click", loadSampleData);
  document.getElementById("predictBtn").addEventListener("click", runPrediction);
  document.getElementById("trainBtn").addEventListener("click", trainModel);

  await Promise.all([loadOptions(), loadStatus()]);
}

initPage();
