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
// Hero picks come from a separate on-demand CitoAPI lookup (see ensureHeroPicks),
// fetched only when a live match's details are expanded, to respect its small
// free-tier quota (500 calls/month) — never part of the auto-refresh polling loop.
const heroPicksCache = new Map();
const pendingHeroPicksKeys = new Set();
const MAX_LIVE_MATCHES = 150;
const LIVE_PAGE_SIZE = 10;
let liveMatchPage = 1;
let liveFetchStats = null;
let teamLogoOverrides = {};
const teamLogoByNormalizedName = new Map();
const teamLogoOverrideByNormalizedName = new Map();
const TEAM_LOGO_CACHE_KEY = "dota_team_logo_index_v1";
const TEAM_LOGO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TEAM_LOGO_PLACEHOLDER = "assets/teams/_placeholder.svg";
const OPENDOTA_TEAMS_URL = "https://api.opendota.com/api/teams";
// Live match data comes from our own PandaScore proxy so the API token never
// reaches the browser. Configure the deployed proxy URL in proxy_config.json;
// this default only works when live_feed_proxy.py is running locally.
let LIVE_FEED_PROXY_URL = "http://127.0.0.1:5050";

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
  if (source.includes("pandascore")) {
    return "PandaScore";
  }
  return "Unknown";
}

function registerTeamLogo(teamName, logoUrl) {
  const key = normalizeTeamName(teamName);
  const url = String(logoUrl || "").trim();
  if (!key || !url || teamLogoByNormalizedName.has(key)) {
    return;
  }
  teamLogoByNormalizedName.set(key, url);
}

// Covers orgs missing from the repo snapshot, such as newly formed teams.
function resolveTeamLogoCandidates(teamName, fallbackUrl) {
  const keys = [normalizeTeamName(teamName)];
  const aliasTarget = teamAliasOverrides[String(teamName || "").trim().toLowerCase()];
  if (typeof aliasTarget === "string") {
    keys.push(normalizeTeamName(aliasTarget));
  }

  const candidates = [];
  keys.forEach((key) => {
    if (key && teamLogoOverrideByNormalizedName.has(key)) {
      candidates.push(teamLogoOverrideByNormalizedName.get(key));
    }
  });
  keys.forEach((key) => {
    if (key && teamLogoByNormalizedName.has(key)) {
      candidates.push(teamLogoByNormalizedName.get(key));
    }
  });

  const fallback = String(fallbackUrl || "").trim();
  if (fallback) {
    candidates.push(fallback);
  }
  candidates.push(TEAM_LOGO_PLACEHOLDER);

  return Array.from(new Set(candidates.filter(Boolean)));
}

async function loadTeamLogoIndex() {
  Object.entries(teamLogoOverrides || {}).forEach(([name, url]) => {
    const key = normalizeTeamName(name);
    const value = String(url || "").trim();
    if (key && value) {
      teamLogoOverrideByNormalizedName.set(key, value);
    }
  });

  try {
    const cachedRaw = localStorage.getItem(TEAM_LOGO_CACHE_KEY);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw);
      if (cached && Date.now() - toInt(cached.saved_at, 0) < TEAM_LOGO_CACHE_TTL_MS) {
        Object.entries(cached.logos || {}).forEach(([key, url]) => {
          if (!teamLogoByNormalizedName.has(key)) {
            teamLogoByNormalizedName.set(key, url);
          }
        });
        return;
      }
    }
  } catch (cacheErr) {
    // Corrupt or unavailable cache is not fatal.
  }

  try {
    const response = await fetch(OPENDOTA_TEAMS_URL, { cache: "no-store" });
    if (!response.ok) {
      return;
    }

    const teams = await response.json();
    const fresh = {};
    (Array.isArray(teams) ? teams : []).forEach((team) => {
      const url = String(team.logo_url || "").trim();
      if (!url) {
        return;
      }
      [team.name, team.tag].forEach((label) => {
        const key = normalizeTeamName(label);
        if (key && !fresh[key]) {
          fresh[key] = url;
        }
        registerTeamLogo(label, url);
      });
    });

    try {
      localStorage.setItem(TEAM_LOGO_CACHE_KEY, JSON.stringify({ saved_at: Date.now(), logos: fresh }));
    } catch (storeErr) {
      // Storage quota issues are non-fatal.
    }
  } catch (err) {
    // Without the team index we still fall back to initials badges.
  }
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

function createTeamBadge(name, logoSource) {
  const candidates = (Array.isArray(logoSource) ? logoSource : [logoSource])
    .map((url) => String(url || "").trim())
    .filter(Boolean);

  if (candidates.length > 0) {
    const logo = document.createElement("img");
    logo.className = "team-logo";
    logo.alt = `${name} logo`;
    logo.loading = "lazy";
    logo.referrerPolicy = "no-referrer";

    let attempt = 0;
    logo.onerror = () => {
      attempt += 1;
      if (attempt < candidates.length) {
        logo.src = candidates[attempt];
        return;
      }
      logo.onerror = null;
      logo.replaceWith(createTeamBadge(name, []));
    };
    logo.src = candidates[0];
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

  // CitoAPI hero picks (fetched on-demand via Show Details) take priority since
  // PandaScore's free plan never exposes them.
  const cachedPicks = heroPicksCache.get(String(match.match_id));
  const picksAvailable = Boolean(cachedPicks && cachedPicks.available);

  for (let i = 0; i < 5; i += 1) {
    document.getElementById(`radiantPlayer${i}`).value = picksAvailable ? (cachedPicks.radiant_players || [])[i] || "" : "";
    document.getElementById(`direPlayer${i}`).value = picksAvailable ? (cachedPicks.dire_players || [])[i] || "" : "";
    document.getElementById(`radiantHero${i}`).value = picksAvailable ? (cachedPicks.radiant_heroes || [])[i] || "" : "";
    document.getElementById(`direHero${i}`).value = picksAvailable ? (cachedPicks.dire_heroes || [])[i] || "" : "";
  }

  if (picksAvailable) {
    setLiveStatus(`Applied from ${sourceLabel}. Teams, players, and hero picks are prefilled.`);
    return;
  }

  // Fall back to the known roster for each team and leave hero fields for manual entry.
  autofillPlayersForSide("radiant", false);
  autofillPlayersForSide("dire", false);

  setLiveStatus(`Applied from ${sourceLabel}. Teams and known rosters are prefilled; enter hero picks manually.`);
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

// The proxy already returns fully normalized matches (see live_feed_proxy.py's
// _normalize_match); this just applies client-side defaults/limits.
function normalizeProxyMatches(payloadMatches) {
  const normalized = (Array.isArray(payloadMatches) ? payloadMatches : []).map((match) => ({
    match_id: toInt(match.match_id, 0),
    source: match.source || "pandascore",
    status: match.status || "upcoming",
    league_name: match.league_name || "Unknown Tournament",
    league_id: toInt(match.league_id, 0),
    radiant_team: match.radiant_team || "TBD",
    dire_team: match.dire_team || "TBD",
    radiant_logo_url: match.radiant_logo_url || "",
    dire_logo_url: match.dire_logo_url || "",
    radiant_score: match.radiant_score === undefined ? null : match.radiant_score,
    dire_score: match.dire_score === undefined ? null : match.dire_score,
    live_seconds: toInt(match.live_seconds, 0),
    live_map_number: toInt(match.live_map_number, 0),
    start_time: toInt(match.start_time, 0),
    series_type: toInt(match.series_type, 0),
    known_picks: toInt(match.known_picks, 0),
    lineup_available: Boolean(match.lineup_available),
    radiant_players: padToFive(match.radiant_players || []),
    dire_players: padToFive(match.dire_players || []),
    radiant_heroes: padToFive(match.radiant_heroes || []),
    dire_heroes: padToFive(match.dire_heroes || []),
    match_url: match.match_url || "",
    games: Array.isArray(match.games) ? match.games : [],
  }));

  return normalized.filter((m) => m.match_id > 0).slice(0, MAX_LIVE_MATCHES);
}

function buildLoadingNote(text) {
  const note = document.createElement("p");
  note.className = "lineup-loading";
  note.textContent = text;
  return note;
}

// PandaScore's free plan reports per-map status/winner but not hero picks or
// player stats, so the series view is a simple map-by-map scoreline.
function buildSeriesMapsSection(match) {
  const wrapper = document.createElement("div");
  wrapper.className = "series-maps";

  const heading = document.createElement("h4");
  heading.className = "series-maps-title";
  heading.textContent = "Maps";
  wrapper.appendChild(heading);

  const games = Array.isArray(match.games) ? match.games : [];
  if (games.length === 0) {
    wrapper.appendChild(buildLoadingNote("No per-map data published for this series yet."));
    return wrapper;
  }

  const list = document.createElement("ul");
  list.className = "series-maps-list";
  games.forEach((game) => {
    const li = document.createElement("li");
    const position = toInt(game.position, 0) || "?";
    let label = `Map ${position}: not started`;
    if (game.status === "running") {
      label = `Map ${position}: live now (${formatClock(match.live_seconds)})`;
    } else if (game.status === "finished") {
      const winnerId = game.winner_id;
      let winnerName = "Unknown";
      if (winnerId && winnerId === match.radiant_team_id) {
        winnerName = match.radiant_team;
      } else if (winnerId && winnerId === match.dire_team_id) {
        winnerName = match.dire_team;
      }
      label = `Map ${position}: finished - won by ${winnerName}`;
    }
    li.textContent = label;
    list.appendChild(li);
  });
  wrapper.appendChild(list);

  return wrapper;
}

// Fetches hero picks/bans from the proxy's CitoAPI-backed lookup exactly once per
// match, on demand (see the comment on heroPicksCache for the quota reasoning).
function ensureHeroPicks(match, onDone) {
  const key = String(match.match_id);
  if (heroPicksCache.has(key) || pendingHeroPicksKeys.has(key)) {
    return;
  }

  pendingHeroPicksKeys.add(key);
  const params = new URLSearchParams({ radiant: match.radiant_team, dire: match.dire_team });
  fetch(`${LIVE_FEED_PROXY_URL}/api/hero_picks?${params.toString()}`, { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : { available: false }))
    .then((data) => {
      heroPicksCache.set(key, data || { available: false });
    })
    .catch(() => {
      heroPicksCache.set(key, { available: false });
    })
    .finally(() => {
      pendingHeroPicksKeys.delete(key);
      if (typeof onDone === "function") {
        onDone();
      }
    });
}

function buildHeroPicksSection(match) {
  const wrapper = document.createElement("div");
  wrapper.className = "hero-picks";

  const heading = document.createElement("h4");
  heading.className = "series-maps-title";
  heading.textContent = "Hero Picks";
  wrapper.appendChild(heading);

  const key = String(match.match_id);
  const cached = heroPicksCache.get(key);

  if (pendingHeroPicksKeys.has(key)) {
    wrapper.appendChild(buildLoadingNote("Looking up hero picks..."));
    return wrapper;
  }

  if (!cached || !cached.available) {
    wrapper.appendChild(buildLoadingNote("Hero picks are not available for this match yet."));
    return wrapper;
  }

  const grid = document.createElement("div");
  grid.className = "map-lineups";
  grid.appendChild(buildDraftLineup("radiant", match.radiant_team, cached.radiant_players, cached.radiant_heroes));
  grid.appendChild(buildDraftLineup("dire", match.dire_team, cached.dire_players, cached.dire_heroes));
  wrapper.appendChild(grid);

  return wrapper;
}

function buildDraftLineup(side, teamName, players, heroes) {
  const list = document.createElement("div");
  list.className = `lineup ${side}`;
  const title = document.createElement("h4");
  title.textContent = teamName;
  list.appendChild(title);

  const ul = document.createElement("ul");
  for (let i = 0; i < 5; i += 1) {
    const li = document.createElement("li");
    const player = (players || [])[i] || `Player ${i + 1}`;
    const hero = (heroes || [])[i] || "(unknown)";
    li.textContent = `${player} - ${hero}`;
    ul.appendChild(li);
  }
  list.appendChild(ul);
  return list;
}

function renderLiveMatchCards(matches) {
  const board = document.getElementById("liveMatchCards");
  board.innerHTML = "";

  if (!matches || matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "live-empty";
    empty.textContent = "No live matches detected from available sources right now.";
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
    const scoreText = match.series_score
      ? match.series_score
      : (
        match.radiant_score !== null && match.dire_score !== null
        ? `${match.radiant_score} - ${match.dire_score}`
        : "Score N/A"
      );
    const infoParts = [String(match.status).toUpperCase(), formatSeries(match.series_type), scoreText];
    // Ended matches carry no trustworthy timestamp from the feeds, so the time slot is dropped.
    if (match.status === "live") {
      infoParts.push(formatClock(match.live_seconds));
    } else if (match.status !== "ended") {
      infoParts.push(formatUtcTime(match.start_time));
    }
    info.textContent = infoParts.join(" | ");

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
        if (match.status === "live") {
          ensureHeroPicks(match, renderLiveBoard);
        }
      }
      renderLiveBoard();
    });

    const applyBtn = document.createElement("button");
    applyBtn.className = "btn btn-primary live-apply";
    applyBtn.type = "button";
    applyBtn.textContent = "Use This Match";
    applyBtn.title = "Prefills teams, rosters, and hero picks when available (live matches look these up on demand).";
    applyBtn.addEventListener("click", () => {
      const matchKeyStr = String(match.match_id);
      if (match.status === "live" && !heroPicksCache.has(matchKeyStr)) {
        applyBtn.disabled = true;
        ensureHeroPicks(match, () => {
          applyBtn.disabled = false;
          applyLiveMatchToForm(match, `${match.radiant_team} vs ${match.dire_team}`);
          renderLiveBoard();
        });
        return;
      }
      applyLiveMatchToForm(match, `${match.radiant_team} vs ${match.dire_team}`);
      renderLiveBoard();
      document.querySelector(".teams-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    actions.appendChild(detailsBtn);
    actions.appendChild(applyBtn);

    top.appendChild(meta);
    top.appendChild(actions);

    const teams = document.createElement("div");
    teams.className = "live-teams";

    const radiant = document.createElement("div");
    radiant.className = "live-team radiant";
    radiant.appendChild(createTeamBadge(match.radiant_team, resolveTeamLogoCandidates(match.radiant_team, match.radiant_logo_url)));
    const radName = document.createElement("span");
    radName.className = "team-name";
    radName.textContent = match.radiant_team;
    radiant.appendChild(radName);

    const versus = document.createElement("span");
    versus.className = "versus";
    versus.textContent = "VS";

    const dire = document.createElement("div");
    dire.className = "live-team dire";
    dire.appendChild(createTeamBadge(match.dire_team, resolveTeamLogoCandidates(match.dire_team, match.dire_logo_url)));
    const direName = document.createElement("span");
    direName.className = "team-name";
    direName.textContent = match.dire_team;
    dire.appendChild(direName);

    teams.appendChild(radiant);
    teams.appendChild(versus);
    teams.appendChild(dire);

    const details = document.createElement("div");
    details.className = "live-details";
    if (!expanded) {
      details.classList.add("hidden");
    }

    if (expanded) {
      if (match.match_url) {
        const streamLink = document.createElement("a");
        streamLink.className = "live-stream-link";
        streamLink.href = match.match_url;
        streamLink.target = "_blank";
        streamLink.rel = "noopener noreferrer";
        streamLink.textContent = "Watch stream";
        details.appendChild(streamLink);
      }
      if ((match.series_type || 0) > 0 || (match.games || []).length > 0) {
        details.appendChild(buildSeriesMapsSection(match));
      }
      if (match.status === "live") {
        details.appendChild(buildHeroPicksSection(match));
      }
    }

    card.appendChild(top);
    card.appendChild(teams);
    card.appendChild(details);
    board.appendChild(card);
  });
}

function renderLivePagination(totalItems, totalPages) {
  const container = document.getElementById("livePagination");
  container.innerHTML = "";

  if (totalPages <= 1) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");

  const makeButton = (label, targetPage, isCurrent = false, disabled = false) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn btn-ghost page-btn${isCurrent ? " current" : ""}`;
    btn.textContent = label;
    btn.disabled = disabled;
    if (!disabled && !isCurrent) {
      btn.addEventListener("click", () => {
        liveMatchPage = targetPage;
        renderLiveBoard();
        document.querySelector(".live-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    return btn;
  };

  container.appendChild(makeButton("Prev", liveMatchPage - 1, false, liveMatchPage <= 1));

  const windowStart = Math.max(1, Math.min(liveMatchPage - 2, totalPages - 4));
  const windowEnd = Math.min(totalPages, Math.max(liveMatchPage + 2, 5));
  for (let page = windowStart; page <= windowEnd; page += 1) {
    container.appendChild(makeButton(String(page), page, page === liveMatchPage));
  }

  container.appendChild(makeButton("Next", liveMatchPage + 1, false, liveMatchPage >= totalPages));

  const label = document.createElement("span");
  label.className = "page-label";
  label.textContent = `Page ${liveMatchPage} of ${totalPages} (${totalItems} matches)`;
  container.appendChild(label);
}

function renderLiveBoard() {
  filteredLiveMatches = applyLiveFilters(liveMatches);

  const totalPages = Math.max(1, Math.ceil(filteredLiveMatches.length / LIVE_PAGE_SIZE));
  liveMatchPage = Math.min(Math.max(1, liveMatchPage), totalPages);
  const startIndex = (liveMatchPage - 1) * LIVE_PAGE_SIZE;
  const pageMatches = filteredLiveMatches.slice(startIndex, startIndex + LIVE_PAGE_SIZE);

  renderLiveMatchCards(pageMatches);
  renderLivePagination(filteredLiveMatches.length, totalPages);

  if (liveMatches.length === 0) {
    setLiveStatus("No live matches available right now.");
    return;
  }

  const refreshText = liveRefreshAt ? liveRefreshAt.toLocaleTimeString() : "not yet";
  const shownFrom = filteredLiveMatches.length === 0 ? 0 : startIndex + 1;
  const shownTo = startIndex + pageMatches.length;
  setLiveStatus(
    `Showing ${shownFrom}-${shownTo} of ${filteredLiveMatches.length} filtered match(es) `
    + `(${liveMatches.length} total). Source: PandaScore. Last refresh: ${refreshText}.`
  );
}

function resetLivePageAndRender() {
  liveMatchPage = 1;
  renderLiveBoard();
}

async function loadLiveMatches() {
  const refreshBtn = document.getElementById("refreshLiveBtn");
  if (refreshBtn.disabled) {
    return;
  }

  refreshBtn.disabled = true;
  refreshBtn.textContent = "Loading...";

  try {
    const response = await fetch(`${LIVE_FEED_PROXY_URL}/api/live_matches`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`proxy returned ${response.status}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error);
    }

    const normalized = normalizeProxyMatches(payload.matches);
    liveMatches = normalized;
    liveFetchStats = payload.meta || null;
    liveRefreshAt = new Date();
    liveMatchPage = 1;
    renderLiveBoard();
  } catch (err) {
    liveMatches = [];
    filteredLiveMatches = [];
    liveFetchStats = null;
    liveMatchPage = 1;
    renderLiveMatchCards([]);
    renderLivePagination(0, 1);
    setLiveStatus(`Live matches unavailable: ${err.message}. Is live_feed_proxy.py running and reachable at ${LIVE_FEED_PROXY_URL}?`);
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
  document.getElementById("liveFilterStatus").addEventListener("change", resetLivePageAndRender);
  document.getElementById("liveFilterSeries").addEventListener("change", resetLivePageAndRender);
  document.getElementById("liveFilterTournament").addEventListener("input", resetLivePageAndRender);
  document.getElementById("liveFilterStatus").value = "live";
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

    try {
      const logoResponse = await fetch("team_logo_overrides.json", { cache: "no-store" });
      if (logoResponse.ok) {
        teamLogoOverrides = await logoResponse.json();
      }
    } catch (logoErr) {
      teamLogoOverrides = {};
    }

    // Points the live board at the deployed live_feed_proxy.py service; see
    // proxy_config.example.json for the format.
    try {
      const proxyConfigResponse = await fetch("proxy_config.json", { cache: "no-store" });
      if (proxyConfigResponse.ok) {
        const proxyConfig = await proxyConfigResponse.json();
        if (proxyConfig && typeof proxyConfig.proxy_base_url === "string" && proxyConfig.proxy_base_url.trim()) {
          LIVE_FEED_PROXY_URL = proxyConfig.proxy_base_url.trim().replace(/\/$/, "");
        }
      }
    } catch (proxyConfigErr) {
      // Fall back to the default LIVE_FEED_PROXY_URL.
    }

    await loadTeamLogoIndex();

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
