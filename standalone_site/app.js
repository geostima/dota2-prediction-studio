const sampleData = {
  radiantTeam: "Nemiga Gaming",
  direTeam: "IC x Insanity",
  radiantPlayers: ["byun", "young G", "hotoke", "CoviSnine", "ariel"],
  direPlayers: ["Rubikon155", "dualrazee", "Norma", "Fernans", "Kidaro"],
  radiantHeroes: ["Shadow Fiend", "Ember Spirit", "Tidehunter", "Keeper of the Light", "Clockwerk"],
  direHeroes: ["Rubick", "Earth Spirit", "Pangolier", "Dark Willow", "Winter Wyvern"],
};

let modelBundle = null;
let playerExactMap = null;
let playerNormalizedMap = null;
let playerNormalizedEntries = [];
let teamRosters = {};
let teamRosterKeys = [];
let teamRosterOverrides = {};
let teamAliasOverrides = {};
let playerAliasOverrides = {};

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function smoothedWinRate(wins, games) {
  return (wins + 1) / (games + 2);
}

function normalizePlayerName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function normalizeTeamName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function initPlayerResolvers() {
  playerExactMap = modelBundle.player_name_to_id || {};
  playerNormalizedMap = {};
  playerNormalizedEntries = [];

  Object.entries(playerExactMap).forEach(([name, id]) => {
    const normalized = normalizePlayerName(name);
    if (!normalized) {
      return;
    }

    if (playerNormalizedMap[normalized] === undefined) {
      playerNormalizedMap[normalized] = id;
    }
    playerNormalizedEntries.push([normalized, id]);
  });
}

function initTeamRosters() {
  teamRosters = { ...(modelBundle.team_rosters || {}) };

  // Trusted manual overrides take priority over exported snapshot data.
  Object.entries(teamRosterOverrides).forEach(([team, players]) => {
    if (!Array.isArray(players) || players.length === 0) {
      return;
    }
    teamRosters[team] = players.slice(0, 5);
  });

  teamRosterKeys = Object.keys(teamRosters);
}

function findTeamRoster(teamName) {
  const raw = (teamName || "").trim();
  if (!raw) {
    return null;
  }

  const aliasTarget = teamAliasOverrides[raw.toLowerCase()];
  if (typeof aliasTarget === "string" && aliasTarget.trim()) {
    const canonical = aliasTarget.trim();
    const fromAlias = teamRosters[canonical];
    if (fromAlias && fromAlias.length) {
      return { teamKey: canonical, players: fromAlias };
    }
  }

  const exact = teamRosters[raw];
  if (exact && exact.length) {
    return { teamKey: raw, players: exact };
  }

  const lower = raw.toLowerCase();
  const caseInsensitive = teamRosterKeys.find((k) => k.toLowerCase() === lower);
  if (caseInsensitive) {
    return { teamKey: caseInsensitive, players: teamRosters[caseInsensitive] };
  }

  const normalizedInput = normalizeTeamName(raw);
  if (!normalizedInput) {
    return null;
  }

  const candidates = teamRosterKeys.filter((k) => normalizeTeamName(k) === normalizedInput);
  if (candidates.length === 1) {
    return { teamKey: candidates[0], players: teamRosters[candidates[0]] };
  }

  const loose = teamRosterKeys.filter((k) => {
    const nk = normalizeTeamName(k);
    return nk.includes(normalizedInput) || normalizedInput.includes(nk);
  });
  if (loose.length === 1) {
    return { teamKey: loose[0], players: teamRosters[loose[0]] };
  }

  return null;
}

function autofillPlayersForSide(side, showStatus = true) {
  if (!modelBundle) {
    return;
  }

  const teamInput = document.getElementById(`${side}Team`);
  const teamName = teamInput.value.trim();
  const match = findTeamRoster(teamName);

  if (!match || !match.players || !match.players.length) {
    if (showStatus && teamName) {
      document.getElementById("statusText").textContent = `No roster match found for team: ${teamName}`;
    }
    return;
  }

  for (let i = 0; i < 5; i += 1) {
    const playerInput = document.getElementById(`${side}Player${i}`);
    if (match.players[i]) {
      playerInput.value = match.players[i];
    }
  }

  if (showStatus) {
    document.getElementById("statusText").textContent = `Auto-filled ${side} players from roster: ${match.teamKey}`;
  }
}

function resolvePlayerId(inputName) {
  const raw = (inputName || "").trim();
  if (!raw) {
    return 0;
  }

  const rawLower = raw.toLowerCase();

  const aliasTarget = playerAliasOverrides[rawLower];
  if (typeof aliasTarget === "number") {
    return aliasTarget;
  }
  if (typeof aliasTarget === "string" && aliasTarget.trim()) {
    const aliasText = aliasTarget.trim();
    const aliasExact = playerExactMap[aliasText.toLowerCase()];
    if (aliasExact) {
      return aliasExact;
    }
    const aliasNormalized = normalizePlayerName(aliasText);
    if (aliasNormalized && playerNormalizedMap[aliasNormalized]) {
      return playerNormalizedMap[aliasNormalized];
    }
  }

  const exact = playerExactMap[rawLower];
  if (exact) {
    return exact;
  }

  const normalizedInput = normalizePlayerName(raw);
  if (!normalizedInput) {
    return 0;
  }

  const normalizedHit = playerNormalizedMap[normalizedInput];
  if (normalizedHit) {
    return normalizedHit;
  }

  // As a final fallback, try a unique fuzzy match on normalized tokens.
  if (normalizedInput.length >= 4) {
    const candidateIds = new Set();
    for (const [candidateNorm, candidateId] of playerNormalizedEntries) {
      if (candidateNorm.includes(normalizedInput) || normalizedInput.includes(candidateNorm)) {
        candidateIds.add(candidateId);
        if (candidateIds.size > 1) {
          break;
        }
      }
    }

    if (candidateIds.size === 1) {
      return Array.from(candidateIds)[0];
    }
  }

  return 0;
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
    const id = resolvePlayerId(p);
    if (!id && p) unresolvedPlayers.push(p);
    return id;
  });

  const direPlayerIds = dire.players.map((p) => {
    const id = resolvePlayerId(p);
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
    ? `Fallback baseline used for unresolved players: ${unresolvedPlayers.join(", ")}. If these are active pros, refresh and re-export the snapshot.`
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
  const teamDatalist = document.getElementById("teamSuggestions");

  heroDatalist.innerHTML = "";
  playerDatalist.innerHTML = "";
  teamDatalist.innerHTML = "";

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

  teamRosterKeys.sort().forEach((team) => {
    const option = document.createElement("option");
    option.value = team;
    teamDatalist.appendChild(option);
  });
}

async function init() {
  createRows("radiant");
  createRows("dire");

  document.getElementById("sampleBtn").addEventListener("click", loadSampleData);
  document.getElementById("predictBtn").addEventListener("click", predict);
  document.getElementById("radiantAutofillBtn").addEventListener("click", () => autofillPlayersForSide("radiant"));
  document.getElementById("direAutofillBtn").addEventListener("click", () => autofillPlayersForSide("dire"));
  document.getElementById("radiantTeam").addEventListener("change", () => autofillPlayersForSide("radiant", false));
  document.getElementById("direTeam").addEventListener("change", () => autofillPlayersForSide("dire", false));

  try {
    const response = await fetch("model_bundle.json", { cache: "no-store" });
    modelBundle = await response.json();

    // Optional file for manual per-team roster corrections.
    try {
      const overrideResponse = await fetch("team_roster_overrides.json", { cache: "no-store" });
      if (overrideResponse.ok) {
        teamRosterOverrides = await overrideResponse.json();
      }
    } catch (overrideErr) {
      teamRosterOverrides = {};
    }

    try {
      const aliasTeamResponse = await fetch("team_alias_overrides.json", { cache: "no-store" });
      if (aliasTeamResponse.ok) {
        teamAliasOverrides = await aliasTeamResponse.json();
      }
    } catch (aliasTeamErr) {
      teamAliasOverrides = {};
    }

    try {
      const aliasPlayerResponse = await fetch("player_alias_overrides.json", { cache: "no-store" });
      if (aliasPlayerResponse.ok) {
        playerAliasOverrides = await aliasPlayerResponse.json();
      }
    } catch (aliasPlayerErr) {
      playerAliasOverrides = {};
    }

    initPlayerResolvers();
    initTeamRosters();
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
