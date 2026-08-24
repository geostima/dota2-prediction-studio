const sampleData = {
  radiantTeam: "Nemiga Gaming",
  direTeam: "IC x Insanity",
  radiantPlayers: ["byun", "young G", "hotoke", "CoviSnine", "ariel"],
  direPlayers: ["Rubikon155", "dualrazee", "Norma", "Fernans", "Kidaro"],
  radiantHeroes: ["Shadow Fiend", "Ember Spirit", "Tidehunter", "Keeper of the Light", "Clockwerk"],
  direHeroes: ["Rubick", "Earth Spirit", "Pangolier", "Dark Willow", "Winter Wyvern"],
};

let modelBundle = null;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function smoothedWinRate(wins, games) {
  return (wins + 1) / (games + 2);
}

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
    playerInput.placeholder = "Player name";
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

function teamComfort(snapshot, playerIds, heroIds) {
  const values = [];
  for (let i = 0; i < 5; i += 1) {
    const p = playerIds[i] || 0;
    const h = heroIds[i] || 0;
    if (!p || !h) {
      values.push(0.5);
      continue;
    }
    const key = `${p}:${h}`;
    const found = snapshot[key];
    if (!found) {
      values.push(0.5);
      continue;
    }
    values.push(smoothedWinRate(found[0], found[1]));
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function renderMetrics(metrics) {
  const box = document.getElementById("metricsBox");
  box.innerHTML = "";
  if (!metrics) {
    return;
  }

  const chips = [
    `status: ${metrics.status || "trained"}`,
    metrics.total_rows !== undefined ? `rows: ${metrics.total_rows}` : null,
    metrics.accuracy !== undefined ? `accuracy: ${(metrics.accuracy * 100).toFixed(2)}%` : null,
    metrics.roc_auc !== undefined && metrics.roc_auc !== null ? `roc_auc: ${metrics.roc_auc.toFixed(4)}` : null,
    metrics.log_loss !== undefined ? `log_loss: ${metrics.log_loss.toFixed(4)}` : null,
    metrics.brier !== undefined ? `brier: ${metrics.brier.toFixed(4)}` : null,
  ].filter(Boolean);

  chips.forEach((text) => {
    const chip = document.createElement("div");
    chip.className = "metric-chip";
    chip.textContent = text;
    box.appendChild(chip);
  });
}

function renderResult(result) {
  const placeholder = document.getElementById("resultPlaceholder");
  const content = document.getElementById("resultContent");

  const winner = result.radiantWinProb >= result.direWinProb ? result.radiantTeam : result.direTeam;
  const winnerPct = Math.max(result.radiantWinProb, result.direWinProb).toFixed(2);

  content.innerHTML = `
    <div class="winner-line">Likely winner: ${winner} (${winnerPct}%)</div>
    <div class="bars">
      <div>
        <div class="bar-label"><span>${result.radiantTeam}</span><span>${result.radiantWinProb.toFixed(2)}%</span></div>
        <div class="bar-track"><div class="bar-fill radiant" style="width:${result.radiantWinProb}%"></div></div>
      </div>
      <div>
        <div class="bar-label"><span>${result.direTeam}</span><span>${result.direWinProb.toFixed(2)}%</span></div>
        <div class="bar-track"><div class="bar-fill dire" style="width:${result.direWinProb}%"></div></div>
      </div>
      <div>
        <div class="bar-label"><span>${result.radiantTeam} comfort</span><span>${result.radiantComfort.toFixed(2)}%</span></div>
        <div class="bar-track"><div class="bar-fill radiant" style="width:${result.radiantComfort}%"></div></div>
      </div>
      <div>
        <div class="bar-label"><span>${result.direTeam} comfort</span><span>${result.direComfort.toFixed(2)}%</span></div>
        <div class="bar-track"><div class="bar-fill dire" style="width:${result.direComfort}%"></div></div>
      </div>
    </div>
    <div class="note">${result.note || ""}</div>
  `;

  placeholder.classList.add("hidden");
  content.classList.remove("hidden");
}

function renderError(message) {
  const placeholder = document.getElementById("resultPlaceholder");
  const content = document.getElementById("resultContent");
  placeholder.classList.remove("hidden");
  placeholder.classList.add("error");
  placeholder.textContent = message;
  content.classList.add("hidden");
}

function predict() {
  if (!modelBundle) {
    renderError("Model bundle is not loaded yet.");
    return;
  }

  const radiant = getTeamInputs("radiant");
  const dire = getTeamInputs("dire");

  const radiantTeam = document.getElementById("radiantTeam").value.trim() || "Radiant";
  const direTeam = document.getElementById("direTeam").value.trim() || "Dire";

  const heroMap = modelBundle.hero_name_to_id;
  const playerMap = modelBundle.player_name_to_id;

  const radiantHeroIds = [];
  const direHeroIds = [];
  const missingHeroes = [];

  radiant.heroes.forEach((h) => {
    const id = heroMap[h.toLowerCase()];
    if (id === undefined) {
      missingHeroes.push(h);
      radiantHeroIds.push(0);
    } else {
      radiantHeroIds.push(id);
    }
  });

  dire.heroes.forEach((h) => {
    const id = heroMap[h.toLowerCase()];
    if (id === undefined) {
      missingHeroes.push(h);
      direHeroIds.push(0);
    } else {
      direHeroIds.push(id);
    }
  });

  if (missingHeroes.length > 0) {
    renderError(`Unknown hero names: ${missingHeroes.join(", ")}`);
    return;
  }

  const unresolvedPlayers = [];
  const radiantPlayerIds = radiant.players.map((p) => {
    const id = playerMap[p.toLowerCase()] || 0;
    if (!id && p) unresolvedPlayers.push(p);
    return id;
  });

  const direPlayerIds = dire.players.map((p) => {
    const id = playerMap[p.toLowerCase()] || 0;
    if (!id && p) unresolvedPlayers.push(p);
    return id;
  });

  const numHeroes = modelBundle.num_heroes;
  const features = new Float32Array(numHeroes + 3);

  radiantHeroIds.forEach((heroId) => {
    if (heroId > 0 && heroId < numHeroes) {
      features[heroId] = 1;
    }
  });

  direHeroIds.forEach((heroId) => {
    if (heroId > 0 && heroId < numHeroes) {
      features[heroId] = -1;
    }
  });

  const radComfort01 = teamComfort(modelBundle.player_hero_snapshot, radiantPlayerIds, radiantHeroIds);
  const direComfort01 = teamComfort(modelBundle.player_hero_snapshot, direPlayerIds, direHeroIds);

  features[numHeroes] = radComfort01;
  features[numHeroes + 1] = direComfort01;
  features[numHeroes + 2] = radComfort01 - direComfort01;

  const coef = modelBundle.coef;
  let score = modelBundle.intercept;
  for (let i = 0; i < features.length; i += 1) {
    score += coef[i] * features[i];
  }

  const radiantProb01 = sigmoid(score);
  const direProb01 = 1 - radiantProb01;

  const note = unresolvedPlayers.length > 0
    ? `Fallback baseline used for unresolved players: ${unresolvedPlayers.join(", ")}`
    : "All players resolved from snapshot.";

  renderResult({
    radiantTeam,
    direTeam,
    radiantWinProb: radiantProb01 * 100,
    direWinProb: direProb01 * 100,
    radiantComfort: radComfort01 * 100,
    direComfort: direComfort01 * 100,
    note,
  });
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

function loadSuggestions() {
  const heroDatalist = document.getElementById("heroSuggestions");
  const playerDatalist = document.getElementById("playerSuggestions");

  heroDatalist.innerHTML = "";
  playerDatalist.innerHTML = "";

  Object.keys(modelBundle.hero_name_to_id).sort().forEach((hero) => {
    const option = document.createElement("option");
    option.value = hero;
    heroDatalist.appendChild(option);
  });

  Object.keys(modelBundle.player_name_to_id).sort().slice(0, 4000).forEach((player) => {
    const option = document.createElement("option");
    option.value = player;
    playerDatalist.appendChild(option);
  });
}

async function init() {
  createRows("radiant");
  createRows("dire");

  document.getElementById("sampleBtn").addEventListener("click", loadSampleData);
  document.getElementById("predictBtn").addEventListener("click", predict);

  try {
    const response = await fetch("model_bundle.json", { cache: "no-store" });
    modelBundle = await response.json();
    document.getElementById("statusText").textContent = `Model ready. Heroes: ${Object.keys(modelBundle.hero_name_to_id).length}, Players: ${Object.keys(modelBundle.player_name_to_id).length}`;
    const generatedAt = modelBundle.generated_at
      ? new Date(modelBundle.generated_at).toLocaleString()
      : "Unknown";
    document.getElementById("bundleUpdatedText").textContent = `Model bundle last updated: ${generatedAt}`;
    renderMetrics(modelBundle.last_train_metrics || {});
    loadSuggestions();
  } catch (err) {
    document.getElementById("statusText").textContent = `Failed to load model bundle: ${err.message}`;
    document.getElementById("bundleUpdatedText").textContent = "Model bundle timestamp unavailable.";
  }
}

init();
