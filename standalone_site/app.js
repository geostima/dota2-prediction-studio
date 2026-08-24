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
let liveMatches = [];
let filteredLiveMatches = [];
let liveRefreshAt = null;
let liveRefreshTimerId = null;
const expandedLiveMatchIds = new Set();
const MAX_LIVE_MATCHES = 30;
let liveFetchStats = null;
const OPENDOTA_LIVE_URL = "https://api.opendota.com/api/live";
const CYBERSCORE_JINA_URL = "https://r.jina.ai/http://cyberscore.live/en/";

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

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function padToFive(items) {
  const output = Array.isArray(items) ? items.slice(0, 5) : [];
  while (output.length < 5) {
    output.push("");
  }
  return output;
}

function resolveLiveTeam(playerObj) {
  if (Object.prototype.hasOwnProperty.call(playerObj, "isRadiant")) {
    return playerObj.isRadiant ? "radiant" : "dire";
  }

  const teamValue = playerObj.team;
  if (teamValue === 0 || teamValue === "0" || teamValue === "radiant" || teamValue === "Radiant") {
    return "radiant";
  }
  if (teamValue === 1 || teamValue === "1" || teamValue === "dire" || teamValue === "Dire") {
    return "dire";
  }

  const slot = toInt(playerObj.player_slot, 999);
  return slot < 128 ? "radiant" : "dire";
}

function heroIdToNameMap() {
  const idToName = {};
  if (!modelBundle || !modelBundle.hero_name_to_id) {
    return idToName;
  }

  Object.entries(modelBundle.hero_name_to_id).forEach(([heroName, heroId]) => {
    const hid = toInt(heroId, 0);
    if (hid > 0 && !idToName[hid]) {
      idToName[hid] = heroName;
    }
  });
  return idToName;
}

function accountIdToPlayerNameMap() {
  const idToName = {};
  if (!modelBundle || !modelBundle.player_name_to_id) {
    return idToName;
  }

  Object.entries(modelBundle.player_name_to_id).forEach(([playerName, accountId]) => {
    const aid = toInt(accountId, 0);
    if (aid > 0 && !idToName[aid]) {
      idToName[aid] = playerName;
    }
  });
  return idToName;
}

function formatSeries(seriesType) {
  const n = toInt(seriesType, -1);
  if (n === 0) return "BO1";
  if (n === 1) return "BO3";
  if (n === 2) return "BO5";
  return "Series";
}

function seriesBestOf(seriesType) {
  const n = toInt(seriesType, -1);
  if (n === 0) return 1;
  if (n === 1) return 3;
  if (n === 2) return 5;
  return 0;
}

function formatClock(secondsValue) {
  const total = toInt(secondsValue, 0);
  if (total <= 0) {
    return "00:00";
  }
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatUtcTime(epochSeconds) {
  const raw = toInt(epochSeconds, 0);
  if (raw <= 0) {
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

function sourceBadgeLabel(sourceName) {
  const source = String(sourceName || "").toLowerCase();
  if (source.includes("cyberscore") && source.includes("opendota")) {
    return "Cyberscore + OpenDota";
  }
  if (source.includes("cyberscore")) {
    return "Cyberscore";
  }
  if (source.includes("opendota")) {
    return "OpenDota";
  }
  if (source.includes("render-proxy")) {
    return "Proxy";
  }
  return "Unknown";
}

function slugToTeamName(slugText) {
  const words = String(slugText || "").split("-").filter(Boolean);
  if (words.length === 0) {
    return "Unknown Team";
  }
  return words.join(" ");
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

function setLiveStatus(text) {
  document.getElementById("liveMatchStatus").textContent = text;
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
      if (String(seriesBestOf(match.series_type)) !== filters.series) {
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

function normalizeLiveMatches(payloadMatches) {
  const heroNamesById = heroIdToNameMap();
  const playerNamesByAccount = accountIdToPlayerNameMap();

  const normalized = [];
  const seenMatchIds = new Set();
  const stats = {
    raw: Array.isArray(payloadMatches) ? payloadMatches.length : 0,
    dropped_no_match_id: 0,
    dropped_duplicate: 0,
    dropped_no_players: 0,
    dropped_unknown_teams: 0,
    dropped_no_league: 0,
    kept: 0,
  };

  (payloadMatches || []).forEach((match, idx) => {
    const matchId = toInt(match.match_id, 0);
    if (!matchId) {
      stats.dropped_no_match_id += 1;
      return;
    }

    if (seenMatchIds.has(matchId)) {
      stats.dropped_duplicate += 1;
      return;
    }
    seenMatchIds.add(matchId);

    const radiantRows = [];
    const direRows = [];

    (match.players || []).forEach((player) => {
      const side = resolveLiveTeam(player);
      if (side !== "radiant" && side !== "dire") {
        return;
      }

      const accountId = toInt(player.account_id, 0);
      const heroId = toInt(player.hero_id, 0);
      const slot = toInt(player.player_slot, 999);

      const playerName =
        (player.name || "").trim()
        || (player.personaname || "").trim()
        || playerNamesByAccount[accountId]
        || (accountId ? `Player ${accountId}` : "");

      const heroName = heroNamesById[heroId] || "";

      if (side === "radiant") {
        radiantRows.push([slot, playerName, heroName]);
      } else {
        direRows.push([slot, playerName, heroName]);
      }
    });

    radiantRows.sort((a, b) => a[0] - b[0]);
    direRows.sort((a, b) => a[0] - b[0]);

    const radiantPlayers = radiantRows.map((row) => row[1]);
    const direPlayers = direRows.map((row) => row[1]);
    const radiantHeroes = radiantRows.map((row) => row[2]);
    const direHeroes = direRows.map((row) => row[2]);

    const lineupAvailable = radiantPlayers.length > 0 && direPlayers.length > 0;
    if (!lineupAvailable) {
      stats.dropped_no_players += 1;
    }

    const radiantTeamObj = match.radiant_team || {};
    const direTeamObj = match.dire_team || {};
    const radiantTeam = (radiantTeamObj.team_name || "").trim() || (match.radiant_name || "").trim() || "Radiant";
    const direTeam = (direTeamObj.team_name || "").trim() || (match.dire_name || "").trim() || "Dire";
    const leagueName = (match.league_name || "").trim();
    const leagueId = toInt(match.league_id, 0);

    const hasNamedTeams =
      radiantTeam && direTeam
      && radiantTeam.toLowerCase() !== "radiant"
      && direTeam.toLowerCase() !== "dire";
    if (!hasNamedTeams) {
      stats.dropped_unknown_teams += 1;
      return;
    }

    if (!leagueName && leagueId <= 0) {
      stats.dropped_no_league += 1;
      return;
    }

    const scoreboard = match.scoreboard || {};
    const liveSeconds = toInt(scoreboard.duration, 0);
    const startTime = toInt(match.start_time, 0);
    const radiantScore = toInt(match.radiant_score, -1);
    const direScore = toInt(match.dire_score, -1);
    const knownPicks = [...radiantHeroes, ...direHeroes].filter((h) => h).length;

    let status = "draft";
    if (liveSeconds > 0) {
      status = "live";
    } else if (startTime > Math.floor(Date.now() / 1000)) {
      status = "upcoming";
    }

    normalized.push({
      match_id: matchId,
      idx,
      source: "opendota-direct",
      status,
      league_name: leagueName,
      league_id: leagueId,
      radiant_team: radiantTeam,
      dire_team: direTeam,
      radiant_logo_url: (radiantTeamObj.logo_url || "").trim() || (radiantTeamObj.logo || "").trim(),
      dire_logo_url: (direTeamObj.logo_url || "").trim() || (direTeamObj.logo || "").trim(),
      radiant_score: radiantScore < 0 ? null : radiantScore,
      dire_score: direScore < 0 ? null : direScore,
      live_seconds: liveSeconds,
      start_time: startTime,
      series_type: toInt(match.series_type, 0),
      known_picks: knownPicks,
      lineup_available: lineupAvailable,
      radiant_players: padToFive(radiantPlayers),
      dire_players: padToFive(direPlayers),
      radiant_heroes: padToFive(radiantHeroes),
      dire_heroes: padToFive(direHeroes),
    });
    stats.kept += 1;
  });

  const statusRank = { live: 0, draft: 1, upcoming: 2 };
  normalized.sort((a, b) => {
    const rankA = statusRank[a.status] ?? 9;
    const rankB = statusRank[b.status] ?? 9;
    if (rankA !== rankB) {
      return rankA - rankB;
    }

    if (a.status === "upcoming") {
      return (a.start_time || 0) - (b.start_time || 0);
    }

    if (a.status === "live" || a.status === "draft") {
      return (b.live_seconds || 0) - (a.live_seconds || 0);
    }

    return b.match_id - a.match_id;
  });

  return {
    matches: normalized.slice(0, MAX_LIVE_MATCHES),
    stats,
  };
}

function normalizeCyberscoreJinaMatches(markdownText) {
  const text = String(markdownText || "");
  const regex = /\[([^\]]+)\]\((https:\/\/cyberscore\.live\/en\/matches\/[^)]+)\)/g;
  const out = [];
  const seen = new Set();
  let m;

  while ((m = regex.exec(text)) !== null) {
    const label = m[1] || "";
    const url = m[2] || "";
    if (!url.includes("/en/matches/")) {
      continue;
    }

    const slug = url.replace(/\/+$/, "").split("/").pop() || "";
    if (!slug.includes("-vs-")) {
      continue;
    }
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);

    const slugParts = slug.split("-vs-");
    if (slugParts.length < 2) {
      continue;
    }

    const leftSlug = slugParts[0];
    const rightWithId = slugParts[1];
    const rightSlug = rightWithId.replace(/-\d+$/, "");

    const scoreMatch = label.match(/(\d+)\s*-\s*(\d+)/);
    const timeMatch = label.match(/(\d{1,2}:\d{2})/);
    const leagueMatch = label.match(/TIER-\d+\s+(.+)$/i);

    const status =
      label.startsWith("LIVE") || label.startsWith("WAIT")
        ? "live"
        : (label.toLowerCase().includes("draft") ? "draft" : "upcoming");

    let liveSeconds = 0;
    if (timeMatch) {
      const [mm, ss] = timeMatch[1].split(":");
      liveSeconds = (Number(mm) || 0) * 60 + (Number(ss) || 0);
    }

    const matchIdMatch = slug.match(/(\d+)$/);
    const matchId = matchIdMatch ? toInt(matchIdMatch[1], 0) : 0;

    out.push({
      match_id: matchId || toInt(Math.abs((leftSlug + rightSlug).split("").reduce((a, c) => a + c.charCodeAt(0), 0)), 0),
      source: "cyberscore-jina",
      idx: out.length,
      status,
      league_name: leagueMatch ? leagueMatch[1].trim() : "",
      league_id: 0,
      radiant_team: slugToTeamName(leftSlug),
      dire_team: slugToTeamName(rightSlug),
      radiant_logo_url: "",
      dire_logo_url: "",
      radiant_score: scoreMatch ? toInt(scoreMatch[1], 0) : null,
      dire_score: scoreMatch ? toInt(scoreMatch[2], 0) : null,
      live_seconds: liveSeconds,
      start_time: 0,
      series_type: label.includes("BO5") ? 2 : (label.includes("BO3") ? 1 : 0),
      known_picks: 0,
      lineup_available: false,
      radiant_players: padToFive([]),
      dire_players: padToFive([]),
      radiant_heroes: padToFive([]),
      dire_heroes: padToFive([]),
      match_url: url,
    });

    if (out.length >= 60) {
      break;
    }
  }

  return out;
}

function mergeOpenDotaAndCyberscore(opendotaMatches, cyberscoreMatches) {
  const byKey = new Map();
  const makeKey = (m) => `${String(m.radiant_team || "").toLowerCase()}|${String(m.dire_team || "").toLowerCase()}|${String(m.league_name || "").toLowerCase()}`;

  (cyberscoreMatches || []).forEach((m) => {
    byKey.set(makeKey(m), { ...m });
  });

  (opendotaMatches || []).forEach((m) => {
    const key = makeKey(m);
    if (!byKey.has(key)) {
      byKey.set(key, { ...m });
      return;
    }

    const existing = byKey.get(key);
    existing.source = "cyberscore+opendota";
    existing.radiant_logo_url = existing.radiant_logo_url || m.radiant_logo_url;
    existing.dire_logo_url = existing.dire_logo_url || m.dire_logo_url;
    existing.live_seconds = m.live_seconds || existing.live_seconds;
    existing.radiant_score = m.radiant_score !== null ? m.radiant_score : existing.radiant_score;
    existing.dire_score = m.dire_score !== null ? m.dire_score : existing.dire_score;
    existing.status = m.status || existing.status;
    existing.lineup_available = Boolean(m.lineup_available) || Boolean(existing.lineup_available);
    existing.radiant_players = m.radiant_players || existing.radiant_players;
    existing.dire_players = m.dire_players || existing.dire_players;
    existing.radiant_heroes = m.radiant_heroes || existing.radiant_heroes;
    existing.dire_heroes = m.dire_heroes || existing.dire_heroes;
  });

  const merged = Array.from(byKey.values());
  const statusRank = { live: 0, draft: 1, upcoming: 2 };
  merged.sort((a, b) => {
    const rankA = statusRank[a.status] ?? 9;
    const rankB = statusRank[b.status] ?? 9;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return (b.live_seconds || 0) - (a.live_seconds || 0);
  });

  return merged.slice(0, MAX_LIVE_MATCHES);
}

function renderLiveMatchCards(matches) {
  const board = document.getElementById("liveMatchCards");
  board.innerHTML = "";

  if (!matches || matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "live-empty";
    empty.textContent = "No live matches detected from OpenDota right now.";
    board.appendChild(empty);
    return;
  }

  matches.forEach((match) => {
    const card = document.createElement("article");
    card.className = "live-card";
    const matchKey = String(match.match_id);
    const expanded = expandedLiveMatchIds.has(matchKey);

    const top = document.createElement("div");
    top.className = "live-top";

    const meta = document.createElement("div");
    meta.className = "live-meta";

    const leagueRow = document.createElement("div");
    leagueRow.className = "live-league-row";

    const league = document.createElement("div");
    league.className = "live-league";
    league.textContent = match.league_name || "Unknown Tournament";

    const sourceBadge = document.createElement("span");
    sourceBadge.className = "source-badge";
    sourceBadge.textContent = sourceBadgeLabel(match.source);

    const info = document.createElement("div");
    info.className = "live-info";
    const scoreText =
      match.radiant_score !== null && match.dire_score !== null
        ? `${match.radiant_score} - ${match.dire_score}`
        : "Score N/A";
    const timeText = match.status === "live" ? formatClock(match.live_seconds) : formatUtcTime(match.start_time);
    info.textContent = `${String(match.status).toUpperCase()} | ${formatSeries(match.series_type)} | ${scoreText} | ${timeText}`;

    leagueRow.appendChild(league);
    leagueRow.appendChild(sourceBadge);
    meta.appendChild(leagueRow);
    meta.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "live-actions";

    const detailsBtn = document.createElement("button");
    detailsBtn.className = "btn btn-ghost live-toggle";
    detailsBtn.type = "button";
    detailsBtn.textContent = expanded ? "Hide Details" : "Show Details";
    detailsBtn.addEventListener("click", () => {
      if (expandedLiveMatchIds.has(matchKey)) {
        expandedLiveMatchIds.delete(matchKey);
      } else {
        expandedLiveMatchIds.add(matchKey);
      }
      renderLiveBoard();
    });

    const applyBtn = document.createElement("button");
    applyBtn.className = "btn btn-ghost live-apply";
    applyBtn.type = "button";
    applyBtn.textContent = "Use This Match";
    applyBtn.addEventListener("click", () => {
      applyLiveMatchToForm(match, `${match.radiant_team} vs ${match.dire_team}`);
    });

    const predictBtn = document.createElement("button");
    predictBtn.className = "btn btn-primary live-predict";
    predictBtn.type = "button";
    predictBtn.textContent = "Predict This Match";
    predictBtn.addEventListener("click", () => {
      applyLiveMatchToForm(match, `${match.radiant_team} vs ${match.dire_team}`);
      predict();
      document.querySelector(".results-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    if (!match.lineup_available || Number(match.known_picks || 0) < 10) {
      predictBtn.disabled = true;
      predictBtn.title = "Prediction requires full detected lineup and all 10 hero picks.";
    }

    actions.appendChild(detailsBtn);
    actions.appendChild(applyBtn);
    actions.appendChild(predictBtn);

    top.appendChild(meta);
    top.appendChild(actions);

    const teams = document.createElement("div");
    teams.className = "live-teams";

    const radiant = document.createElement("div");
    radiant.className = "live-team radiant";
    radiant.appendChild(createTeamBadge(match.radiant_team, match.radiant_logo_url));
    const radName = document.createElement("span");
    radName.className = "team-name";
    radName.textContent = match.radiant_team;
    radiant.appendChild(radName);

    const versus = document.createElement("span");
    versus.className = "versus";
    versus.textContent = "VS";

    const dire = document.createElement("div");
    dire.className = "live-team dire";
    dire.appendChild(createTeamBadge(match.dire_team, match.dire_logo_url));
    const direName = document.createElement("span");
    direName.className = "team-name";
    direName.textContent = match.dire_team;
    dire.appendChild(direName);

    teams.appendChild(radiant);
    teams.appendChild(versus);
    teams.appendChild(dire);

    const draft = document.createElement("div");
    draft.className = "live-draft";
    if (!match.lineup_available) {
      draft.textContent = "Lineup data is not yet exposed by feed. Team/tournament info only for now.";
    } else {
      draft.textContent = `Draft progress: ${Number(match.known_picks || 0)}/10 picks known`;
    }

    const details = document.createElement("div");
    details.className = "live-details";
    if (!expanded) {
      details.classList.add("hidden");
    }

    const radList = document.createElement("div");
    radList.className = "lineup radiant";
    const radTitle = document.createElement("h4");
    radTitle.textContent = `${match.radiant_team} lineup`;
    radList.appendChild(radTitle);
    const radUl = document.createElement("ul");
    for (let i = 0; i < 5; i += 1) {
      const li = document.createElement("li");
      const player = match.radiant_players[i] || `Player ${i + 1}`;
      const hero = match.radiant_heroes[i] || "(hero not picked)";
      li.textContent = `${player} - ${hero}`;
      radUl.appendChild(li);
    }
    radList.appendChild(radUl);

    const direList = document.createElement("div");
    direList.className = "lineup dire";
    const direTitle = document.createElement("h4");
    direTitle.textContent = `${match.dire_team} lineup`;
    direList.appendChild(direTitle);
    const direUl = document.createElement("ul");
    for (let i = 0; i < 5; i += 1) {
      const li = document.createElement("li");
      const player = match.dire_players[i] || `Player ${i + 1}`;
      const hero = match.dire_heroes[i] || "(hero not picked)";
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
  filteredLiveMatches = applyLiveFilters(liveMatches);
  renderLiveMatchCards(filteredLiveMatches);

  if (liveMatches.length === 0) {
    if (liveFetchStats) {
      setLiveStatus(
        `No valid pro matches right now (raw: ${liveFetchStats.raw}, dropped unnamed/no-league lobbies: `
        + `${liveFetchStats.dropped_unknown_teams + liveFetchStats.dropped_no_league}).`
      );
    } else {
      setLiveStatus("No live matches available right now.");
    }
    return;
  }

  const refreshText = liveRefreshAt ? liveRefreshAt.toLocaleTimeString() : "not yet";
  const provider = (liveFetchStats && liveFetchStats.provider) ? liveFetchStats.provider : "unknown";
  setLiveStatus(
    `Showing ${filteredLiveMatches.length}/${liveMatches.length} match(es). Source: ${provider}. Last refresh: ${refreshText}.`
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
    let openDotaNormalized = { matches: [], stats: { provider: "opendota-direct" } };
    let cyberscoreMatches = [];
    const warnings = [];

    try {
      const rOpen = await fetch(OPENDOTA_LIVE_URL, { cache: "no-store" });
      if (!rOpen.ok) {
        throw new Error(`OpenDota returned ${rOpen.status}`);
      }
      openDotaNormalized = normalizeLiveMatches(await rOpen.json());
      openDotaNormalized.stats.provider = "opendota-direct";
    } catch (e) {
      warnings.push(`opendota: ${String(e.message || e)}`);
    }

    try {
      const rCyber = await fetch(CYBERSCORE_JINA_URL, { cache: "no-store" });
      if (!rCyber.ok) {
        throw new Error(`cyberscore-jina returned ${rCyber.status}`);
      }
      cyberscoreMatches = normalizeCyberscoreJinaMatches(await rCyber.text());
    } catch (e) {
      warnings.push(`cyberscore-jina: ${String(e.message || e)}`);
    }

    const mergedMatches = mergeOpenDotaAndCyberscore(openDotaNormalized.matches || [], cyberscoreMatches || []);
    if (mergedMatches.length === 0) {
      throw new Error(warnings.join(" | ") || "No live providers returned matches");
    }

    liveMatches = mergedMatches;
    liveFetchStats = {
      ...(openDotaNormalized.stats || {}),
      provider: "opendota+cyberscore-jina",
      opendota_count: (openDotaNormalized.matches || []).length,
      cyberscore_count: (cyberscoreMatches || []).length,
      merged_count: mergedMatches.length,
      warnings,
    };
    liveRefreshAt = new Date();
    renderLiveBoard();
  } catch (err) {
    liveMatches = [];
    filteredLiveMatches = [];
    liveFetchStats = null;
    renderLiveMatchCards([]);
    setLiveStatus(`Live matches unavailable: ${err.message}`);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh Live Matches";
  }
}

function setupLiveAutoRefresh() {
  const checkbox = document.getElementById("liveAutoRefresh");

  if (liveRefreshTimerId) {
    clearInterval(liveRefreshTimerId);
    liveRefreshTimerId = null;
  }

  if (checkbox.checked) {
    liveRefreshTimerId = setInterval(() => {
      loadLiveMatches();
    }, 45000);
  }
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
  document.getElementById("refreshLiveBtn").addEventListener("click", loadLiveMatches);
  document.getElementById("liveAutoRefresh").addEventListener("change", setupLiveAutoRefresh);
  document.getElementById("liveFilterStatus").addEventListener("change", renderLiveBoard);
  document.getElementById("liveFilterSeries").addEventListener("change", renderLiveBoard);
  document.getElementById("liveFilterTournament").addEventListener("input", renderLiveBoard);
  setupLiveAutoRefresh();

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
    await loadLiveMatches();
  } catch (err) {
    document.getElementById("statusText").textContent = `Failed to load model bundle: ${err.message}`;
    document.getElementById("bundleUpdatedText").textContent = "Model bundle timestamp unavailable.";
    setLiveStatus("Live matches unavailable until model bundle loads.");
  }
}

init();
