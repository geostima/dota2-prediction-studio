const state = {
  heroes: [],
  players: [],
  liveMatches: [],
  filteredLiveMatches: [],
  liveRefreshAt: null,
  liveRefreshTimerId: null,
  expandedMatchIds: new Set(),
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

function setLiveStatus(text) {
  document.getElementById("liveMatchStatus").textContent = text;
}

function getSeriesBestOf(seriesType) {
  const n = Number(seriesType || 0);
  if (n === 0) return 1;
  if (n === 1) return 3;
  if (n === 2) return 5;
  return 0;
}

function getLiveFilters() {
  return {
    status: document.getElementById("liveFilterStatus").value,
    series: document.getElementById("liveFilterSeries").value,
    query: document.getElementById("liveFilterTournament").value.trim().toLowerCase(),
  };
}

function applyLiveFilters(matches) {
  const filters = getLiveFilters();
  return (matches || []).filter((match) => {
    if (filters.status !== "all" && String(match.status || "") !== filters.status) {
      return false;
    }

    if (filters.series !== "all") {
      const bestOf = getSeriesBestOf(match.series_type);
      if (String(bestOf) !== filters.series) {
        return false;
      }
    }

    if (filters.query) {
      const haystack = [
        String(match.league_name || "").toLowerCase(),
        String(match.radiant_team || "").toLowerCase(),
        String(match.dire_team || "").toLowerCase(),
      ].join(" ");
      if (!haystack.includes(filters.query)) {
        return false;
      }
    }

    return true;
  });
}

function formatClock(secondsValue) {
  const total = Number(secondsValue || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return "00:00";
  }
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatUtcTime(epochSeconds) {
  const raw = Number(epochSeconds || 0);
  if (!Number.isFinite(raw) || raw <= 0) {
    return "TBD";
  }
  const date = new Date(raw * 1000);
  return date.toLocaleString([], {
    hour12: false,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatSeries(seriesType) {
  const n = Number(seriesType || 0);
  if (n === 0) return "BO1";
  if (n === 1) return "BO3";
  if (n === 2) return "BO5";
  return "Series";
}

function createTeamBadge(name, logoUrl) {
  if (logoUrl) {
    const logo = document.createElement("img");
    logo.className = "team-logo";
    logo.src = logoUrl;
    logo.alt = `${name} logo`;
    logo.loading = "lazy";
    logo.referrerPolicy = "no-referrer";
    logo.onerror = () => {
      logo.replaceWith(createTeamBadge(name, ""));
    };
    return logo;
  }

  const fallback = document.createElement("span");
  fallback.className = "team-logo fallback";
  const words = (name || "?").trim().split(/\s+/).filter(Boolean);
  fallback.textContent = (words[0]?.[0] || "?") + (words[1]?.[0] || "");
  return fallback;
}

function applyLiveMatchToForm(match, sourceLabel = "live board") {
  document.getElementById("radiantTeam").value = match.radiant_team || "Radiant";
  document.getElementById("direTeam").value = match.dire_team || "Dire";

  for (let i = 0; i < 5; i += 1) {
    document.getElementById(`radiantPlayer${i}`).value = (match.radiant_players || [])[i] || "";
    document.getElementById(`direPlayer${i}`).value = (match.dire_players || [])[i] || "";
    document.getElementById(`radiantHero${i}`).value = (match.radiant_heroes || [])[i] || "";
    document.getElementById(`direHero${i}`).value = (match.dire_heroes || [])[i] || "";
  }

  const hasUnpicked = [...(match.radiant_heroes || []), ...(match.dire_heroes || [])].some((hero) => !hero);
  if (hasUnpicked) {
    setLiveStatus(`Applied from ${sourceLabel}. Some heroes are not picked yet, so those hero fields were left blank.`);
  } else {
    setLiveStatus(`Applied from ${sourceLabel}. Teams, players, and heroes are now prefilled.`);
  }
}

async function quickPredictMatch(match, buttonEl) {
  const oldText = buttonEl.textContent;
  buttonEl.disabled = true;
  buttonEl.textContent = "Predicting...";

  applyLiveMatchToForm(match, `${match.radiant_team} vs ${match.dire_team}`);
  await runPrediction();

  buttonEl.disabled = false;
  buttonEl.textContent = oldText;
  document.getElementById("resultsPanel").scrollIntoView({ behavior: "smooth", block: "start" });
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

function renderLiveMatchCards(matches) {
  const board = document.getElementById("liveMatchCards");
  board.innerHTML = "";

  if (!matches || matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "live-empty";
    empty.textContent = "No live matches detected from OpenDota at the moment.";
    board.appendChild(empty);
    return;
  }

  matches.forEach((match, index) => {
    const card = document.createElement("article");
    card.className = "live-card";
    const matchId = String(match.match_id || `idx-${index}`);
    const expanded = state.expandedMatchIds.has(matchId);
    if (expanded) {
      card.classList.add("expanded");
    }

    const top = document.createElement("div");
    top.className = "live-top";

    const meta = document.createElement("div");
    meta.className = "live-meta";

    const league = document.createElement("div");
    league.className = "live-league";
    league.textContent = match.league_name || "Unknown Tournament";

    const info = document.createElement("div");
    info.className = "live-info";
    const statusLabel = String(match.status || "draft").toUpperCase();
    const scoreText =
      match.radiant_score !== null && match.dire_score !== null
        ? `${match.radiant_score} - ${match.dire_score}`
        : "Score N/A";
    const clockText = match.status === "live" ? formatClock(match.live_seconds) : formatUtcTime(match.start_time);
    info.textContent = `${statusLabel} | ${formatSeries(match.series_type)} | ${scoreText} | ${clockText}`;

    meta.appendChild(league);
    meta.appendChild(info);

    const actionGroup = document.createElement("div");
    actionGroup.className = "live-actions";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "btn btn-ghost live-toggle";
    toggleBtn.type = "button";
    toggleBtn.textContent = expanded ? "Hide Details" : "Show Details";
    toggleBtn.addEventListener("click", () => {
      if (state.expandedMatchIds.has(matchId)) {
        state.expandedMatchIds.delete(matchId);
      } else {
        state.expandedMatchIds.add(matchId);
      }
      renderLiveBoard();
    });

    const applyBtn = document.createElement("button");
    applyBtn.className = "btn btn-secondary live-apply";
    applyBtn.type = "button";
    applyBtn.textContent = "Use This Match";
    applyBtn.dataset.index = String(index);
    applyBtn.addEventListener("click", () => {
      applyLiveMatchToForm(match, `${match.radiant_team} vs ${match.dire_team}`);
    });

    const predictBtn = document.createElement("button");
    predictBtn.className = "btn btn-primary live-predict";
    predictBtn.type = "button";
    predictBtn.textContent = "Predict This Match";
    predictBtn.addEventListener("click", async () => {
      await quickPredictMatch(match, predictBtn);
    });

    actionGroup.appendChild(toggleBtn);
    actionGroup.appendChild(applyBtn);
    actionGroup.appendChild(predictBtn);

    top.appendChild(meta);
    top.appendChild(actionGroup);

    const teams = document.createElement("div");
    teams.className = "live-teams";

    const radiant = document.createElement("div");
    radiant.className = "live-team radiant";
    radiant.appendChild(createTeamBadge(match.radiant_team, match.radiant_logo_url));
    const radName = document.createElement("span");
    radName.className = "team-name";
    radName.textContent = match.radiant_team || "Radiant";
    radiant.appendChild(radName);

    const versus = document.createElement("span");
    versus.className = "versus";
    versus.textContent = "VS";

    const dire = document.createElement("div");
    dire.className = "live-team dire";
    dire.appendChild(createTeamBadge(match.dire_team, match.dire_logo_url));
    const direName = document.createElement("span");
    direName.className = "team-name";
    direName.textContent = match.dire_team || "Dire";
    dire.appendChild(direName);

    teams.appendChild(radiant);
    teams.appendChild(versus);
    teams.appendChild(dire);

    const draft = document.createElement("div");
    draft.className = "live-draft";
    draft.textContent = `Draft progress: ${Number(match.known_picks || 0)}/10 picks known`;

    const details = document.createElement("div");
    details.className = "live-details";
    if (!expanded) {
      details.classList.add("hidden");
    }

    const radList = document.createElement("div");
    radList.className = "lineup radiant";
    const radTitle = document.createElement("h4");
    radTitle.textContent = `${match.radiant_team || "Radiant"} lineup`;
    radList.appendChild(radTitle);

    const radUl = document.createElement("ul");
    for (let i = 0; i < 5; i += 1) {
      const li = document.createElement("li");
      const player = (match.radiant_players || [])[i] || `Player ${i + 1}`;
      const hero = (match.radiant_heroes || [])[i] || "(hero not picked)";
      li.textContent = `${player} - ${hero}`;
      radUl.appendChild(li);
    }
    radList.appendChild(radUl);

    const direList = document.createElement("div");
    direList.className = "lineup dire";
    const direTitle = document.createElement("h4");
    direTitle.textContent = `${match.dire_team || "Dire"} lineup`;
    direList.appendChild(direTitle);

    const direUl = document.createElement("ul");
    for (let i = 0; i < 5; i += 1) {
      const li = document.createElement("li");
      const player = (match.dire_players || [])[i] || `Player ${i + 1}`;
      const hero = (match.dire_heroes || [])[i] || "(hero not picked)";
      li.textContent = `${player} - ${hero}`;
      direUl.appendChild(li);
    }
    direList.appendChild(direUl);

    details.appendChild(radList);
    details.appendChild(direList);

    card.appendChild(top);
    card.appendChild(teams);
    card.appendChild(draft);
    card.appendChild(details);
    board.appendChild(card);
  });
}

function renderLiveBoard() {
  state.filteredLiveMatches = applyLiveFilters(state.liveMatches);
  renderLiveMatchCards(state.filteredLiveMatches);

  if (state.liveMatches.length === 0) {
    setLiveStatus("No live matches available right now.");
    return;
  }

  const refreshText = state.liveRefreshAt ? state.liveRefreshAt.toLocaleTimeString() : "not yet";
  setLiveStatus(
    `Showing ${state.filteredLiveMatches.length}/${state.liveMatches.length} match(es). Last refresh: ${refreshText}.`
  );
}

async function loadLiveMatches() {
  const refreshBtn = document.getElementById("refreshLiveBtn");
  if (refreshBtn.disabled) {
    return;
  }
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Loading...";

  try {
    const response = await fetch("/api/live_matches?limit=25");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to load live matches");
    }

    state.liveMatches = data.matches || [];
    state.liveRefreshAt = new Date();
    renderLiveBoard();
  } catch (error) {
    state.liveMatches = [];
    state.filteredLiveMatches = [];
    renderLiveMatchCards([]);
    setLiveStatus(`Could not load live matches: ${error.message}`);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh Live Matches";
  }
}

function setupLiveAutoRefresh() {
  const checkbox = document.getElementById("liveAutoRefresh");

  if (state.liveRefreshTimerId) {
    clearInterval(state.liveRefreshTimerId);
    state.liveRefreshTimerId = null;
  }

  if (checkbox.checked) {
    state.liveRefreshTimerId = setInterval(() => {
      loadLiveMatches();
    }, 45000);
  }
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
  document.getElementById("refreshLiveBtn").addEventListener("click", loadLiveMatches);
  document.getElementById("liveAutoRefresh").addEventListener("change", setupLiveAutoRefresh);
  document.getElementById("liveFilterStatus").addEventListener("change", renderLiveBoard);
  document.getElementById("liveFilterSeries").addEventListener("change", renderLiveBoard);
  document.getElementById("liveFilterTournament").addEventListener("input", renderLiveBoard);
  setupLiveAutoRefresh();

  await Promise.all([loadOptions(), loadStatus()]);
  await loadLiveMatches();
}

initPage();
