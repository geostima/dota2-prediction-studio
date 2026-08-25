"""Server-side proxy that turns PandaScore fixtures data into the live-match
feed consumed by standalone_site/app.js.

The PandaScore API token must never be shipped to the browser: this Flask
service holds it server-side (via the PANDASCORE_API_TOKEN environment
variable), polls PandaScore on a cache schedule that comfortably stays under
the free-tier 1000 requests/hour budget, and serves normalized JSON to the
static site. Finished matches are also archived to a local SQLite database
so they can later be used to build a team-statistics model from PandaScore
data instead of OpenDota.

Hero picks/bans (which PandaScore's free plan does not expose) are fetched
on-demand from CitoAPI, whose Dota 2 free tier is capped at 500 calls/month
and 10 calls/minute, so that integration is only ever called when a user
expands a live match's details, never on the polling loop, and is guarded by
a persisted monthly usage counter plus a minimum-interval rate limiter.
"""
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

PANDASCORE_BASE_URL = "https://api.pandascore.co"
PANDASCORE_TOKEN = os.environ.get("PANDASCORE_API_TOKEN", "").strip()
REQUEST_TIMEOUT = 12
DB_PATH = os.environ.get(
    "PANDASCORE_DB_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "pandascore_data.db")
)

CITOAPI_BASE_URL = "https://api.citoapi.com/api/v1"
CITOAPI_TOKEN = os.environ.get("CITOAPI_API_KEY", "").strip()
# Stay safely under CitoAPI's free-tier 500 calls/month and 10 calls/minute caps.
CITOAPI_MONTHLY_CAP = int(os.environ.get("CITOAPI_MONTHLY_CAP", "450"))
CITOAPI_MIN_CALL_INTERVAL_SECONDS = 7.0
CITOAPI_LIVE_LIST_TTL_SECONDS = 120

_citoapi_call_lock = threading.Lock()
_citoapi_last_call_at = 0.0
_citoapi_live_cache: Dict = {"data": [], "at": 0.0}
_citoapi_detail_cache: Dict[str, Dict] = {}

_citoapi_session = requests.Session()
if CITOAPI_TOKEN:
    _citoapi_session.headers.update({"x-api-key": CITOAPI_TOKEN})

# Cache TTLs are tuned to stay well under PandaScore's free 1000 req/hour cap
# regardless of how many visitors hit our own /api endpoints, since only this
# proxy (not each browser) ever talks to PandaScore directly.
RUNNING_TTL_SECONDS = 20
UPCOMING_TTL_SECONDS = 120
PAST_TTL_SECONDS = 300
UPCOMING_WINDOW_SECONDS = 6 * 60 * 60  # show matches starting within 6 hours

_cache_lock = threading.Lock()
_cache: Dict[str, Dict] = {
    "running": {"data": [], "at": 0.0},
    "upcoming": {"data": [], "at": 0.0},
    "past": {"data": [], "at": 0.0},
}
_last_rate_limit: Dict[str, str] = {}

_session = requests.Session()
if PANDASCORE_TOKEN:
    _session.headers.update({"Authorization": f"Bearer {PANDASCORE_TOKEN}"})


def _cors_json(payload, status=200):
    response = jsonify(payload)
    response.status_code = status
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def _to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_iso(ts: Optional[str]) -> int:
    if not ts:
        return 0
    try:
        dt = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        return 0


def _init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS pandascore_finished_matches (
            match_id INTEGER PRIMARY KEY,
            league_name TEXT,
            serie_name TEXT,
            tournament_name TEXT,
            team_a_id INTEGER,
            team_a_name TEXT,
            team_b_id INTEGER,
            team_b_name TEXT,
            team_a_score INTEGER,
            team_b_score INTEGER,
            winner_id INTEGER,
            winner_name TEXT,
            number_of_games INTEGER,
            begin_at TEXT,
            end_at TEXT,
            fetched_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS citoapi_usage (
            month_key TEXT PRIMARY KEY,
            calls INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.commit()
    conn.close()


def _citoapi_usage_count(month_key: str) -> int:
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("SELECT calls FROM citoapi_usage WHERE month_key = ?", (month_key,)).fetchone()
    conn.close()
    return int(row[0]) if row else 0


def _citoapi_increment_usage(month_key: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        INSERT INTO citoapi_usage (month_key, calls) VALUES (?, 1)
        ON CONFLICT(month_key) DO UPDATE SET calls = calls + 1
        """,
        (month_key,),
    )
    conn.commit()
    conn.close()


def _citoapi_get(path: str) -> Dict:
    if not CITOAPI_TOKEN:
        raise RuntimeError("CITOAPI_API_KEY is not configured on the server")

    month_key = datetime.now(timezone.utc).strftime("%Y-%m")
    with _citoapi_call_lock:
        if _citoapi_usage_count(month_key) >= CITOAPI_MONTHLY_CAP:
            raise RuntimeError("citoapi monthly call budget reached; try again next month")

        global _citoapi_last_call_at
        elapsed = time.time() - _citoapi_last_call_at
        if elapsed < CITOAPI_MIN_CALL_INTERVAL_SECONDS:
            time.sleep(CITOAPI_MIN_CALL_INTERVAL_SECONDS - elapsed)

        response = _citoapi_session.get(f"{CITOAPI_BASE_URL}{path}", timeout=REQUEST_TIMEOUT)
        _citoapi_last_call_at = time.time()
        response.raise_for_status()
        _citoapi_increment_usage(month_key)

        return response.json().get("data")


def _normalize_team_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _teams_fuzzy_match(a: str, b: str) -> bool:
    left, right = _normalize_team_key(a), _normalize_team_key(b)
    if not left or not right:
        return False
    if left == right:
        return True
    if min(len(left), len(right)) < 4:
        return False
    return left in right or right in left


def _citoapi_find_live_match(radiant_name: str, dire_name: str) -> Optional[Dict]:
    now = time.time()
    if now - _citoapi_live_cache["at"] >= CITOAPI_LIVE_LIST_TTL_SECONDS:
        data = _citoapi_get("/dota2/matches/live") or {}
        _citoapi_live_cache["data"] = data.get("matches") or []
        _citoapi_live_cache["at"] = now

    for candidate in _citoapi_live_cache["data"]:
        team1 = candidate.get("team1Name") or ""
        team2 = candidate.get("team2Name") or ""
        if (_teams_fuzzy_match(team1, radiant_name) and _teams_fuzzy_match(team2, dire_name)) or (
            _teams_fuzzy_match(team1, dire_name) and _teams_fuzzy_match(team2, radiant_name)
        ):
            return candidate

    return None


def _citoapi_hero_picks(radiant_name: str, dire_name: str) -> Dict:
    match = _citoapi_find_live_match(radiant_name, dire_name)
    if not match:
        return {"available": False, "reason": "match_not_found_on_citoapi"}

    match_id = match.get("id")
    cache_key = str(match_id)
    cached = _citoapi_detail_cache.get(cache_key)
    if cached and (cached.get("final") or time.time() - cached.get("at", 0) < 60):
        return cached["result"]

    rows = _citoapi_get(f"/dota2/matches/{match_id}/player-stats") or []
    if not rows:
        result = {"available": False, "reason": "no_player_stats_yet"}
        _citoapi_detail_cache[cache_key] = {"result": result, "at": time.time(), "final": False}
        return result

    # player-stats can include earlier games of the same series; keep only the
    # most recent game so picks reflect the map currently being played.
    game_ids = [row.get("gameId") for row in rows if row.get("gameId")]
    latest_game_id = max(game_ids, default=None)
    current_rows = [r for r in rows if r.get("gameId") == latest_game_id] if latest_game_id else rows

    radiant_rows = [r for r in current_rows if r.get("isRadiant") is True]
    dire_rows = [r for r in current_rows if r.get("isRadiant") is False]

    # CitoAPI's team id scheme is inconsistent across sources, so realign sides
    # by fuzzy-matching team names instead of trusting numeric/slug team ids.
    if radiant_rows and not _teams_fuzzy_match(radiant_rows[0].get("teamName", ""), radiant_name):
        radiant_rows, dire_rows = dire_rows, radiant_rows

    radiant_players = [r.get("playerName") or "" for r in radiant_rows]
    radiant_heroes = [r.get("heroName") or "" for r in radiant_rows]
    dire_players = [r.get("playerName") or "" for r in dire_rows]
    dire_heroes = [r.get("heroName") or "" for r in dire_rows]

    result = {
        "available": len(current_rows) > 0,
        "radiant_players": (radiant_players + [""] * 5)[:5],
        "dire_players": (dire_players + [""] * 5)[:5],
        "radiant_heroes": (radiant_heroes + [""] * 5)[:5],
        "dire_heroes": (dire_heroes + [""] * 5)[:5],
    }
    _citoapi_detail_cache[cache_key] = {
        "result": result,
        "at": time.time(),
        "final": len(current_rows) >= 10,
    }
    return result


def _persist_finished_matches(raw_matches: List[Dict]):
    if not raw_matches:
        return

    rows = []
    for raw in raw_matches:
        if raw.get("status") != "finished":
            continue

        opponents = raw.get("opponents") or []
        team_a = ((opponents[0] or {}).get("opponent") or {}) if len(opponents) > 0 else {}
        team_b = ((opponents[1] or {}).get("opponent") or {}) if len(opponents) > 1 else {}
        results = {r.get("team_id"): r.get("score") for r in (raw.get("results") or [])}
        winner = raw.get("winner") or {}

        rows.append(
            (
                raw.get("id"),
                (raw.get("league") or {}).get("name"),
                (raw.get("serie") or {}).get("full_name"),
                (raw.get("tournament") or {}).get("name"),
                team_a.get("id"),
                team_a.get("name"),
                team_b.get("id"),
                team_b.get("name"),
                results.get(team_a.get("id")),
                results.get(team_b.get("id")),
                winner.get("id"),
                winner.get("name"),
                raw.get("number_of_games"),
                raw.get("begin_at"),
                raw.get("end_at"),
                datetime.now(timezone.utc).isoformat(),
            )
        )

    if not rows:
        return

    conn = sqlite3.connect(DB_PATH)
    conn.executemany(
        """
        INSERT INTO pandascore_finished_matches (
            match_id, league_name, serie_name, tournament_name,
            team_a_id, team_a_name, team_b_id, team_b_name,
            team_a_score, team_b_score, winner_id, winner_name,
            number_of_games, begin_at, end_at, fetched_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(match_id) DO UPDATE SET
            team_a_score=excluded.team_a_score,
            team_b_score=excluded.team_b_score,
            winner_id=excluded.winner_id,
            winner_name=excluded.winner_name,
            end_at=excluded.end_at,
            fetched_at=excluded.fetched_at
        """,
        rows,
    )
    conn.commit()
    conn.close()


def _pandascore_get(path: str, params: Optional[Dict] = None) -> List[Dict]:
    if not PANDASCORE_TOKEN:
        raise RuntimeError("PANDASCORE_API_TOKEN is not configured on the server")

    response = _session.get(f"{PANDASCORE_BASE_URL}{path}", params=params, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    _last_rate_limit["remaining"] = response.headers.get("X-Rate-Limit-Remaining", "")
    _last_rate_limit["used"] = response.headers.get("X-Rate-Limit-Used", "")
    payload = response.json()
    return payload if isinstance(payload, list) else []


def _fetch_running(limit=50) -> List[Dict]:
    return _pandascore_get("/dota2/matches/running", {"per_page": limit})


def _fetch_upcoming(limit=50) -> List[Dict]:
    return _pandascore_get("/dota2/matches/upcoming", {"per_page": limit, "sort": "begin_at"})


def _fetch_past(limit=30) -> List[Dict]:
    return _pandascore_get("/dota2/matches/past", {"per_page": limit, "sort": "-end_at"})


_FETCHERS = {"running": _fetch_running, "upcoming": _fetch_upcoming, "past": _fetch_past}
_TTLS = {"running": RUNNING_TTL_SECONDS, "upcoming": UPCOMING_TTL_SECONDS, "past": PAST_TTL_SECONDS}


def _get_cached(kind: str) -> List[Dict]:
    with _cache_lock:
        entry = _cache[kind]
        if entry["data"] and (time.time() - entry["at"] < _TTLS[kind]):
            return entry["data"]

        try:
            data = _FETCHERS[kind](limit=50)
        except Exception:
            return entry["data"]

        _cache[kind] = {"data": data, "at": time.time()}

    if kind == "past":
        try:
            _persist_finished_matches(data)
        except Exception:
            pass

    return data


def _stream_url(raw: Dict) -> str:
    best = ""
    for stream in raw.get("streams_list") or []:
        url = stream.get("raw_url") or stream.get("embed_url") or ""
        if not url:
            continue
        if stream.get("main"):
            return url
        best = best or url
    return best


def _series_type_from_games(number_of_games: int) -> int:
    if number_of_games >= 5:
        return 2
    if number_of_games >= 3:
        return 1
    return 0


def _normalize_match(raw: Dict) -> Optional[Dict]:
    match_id = _to_int(raw.get("id"), 0)
    if not match_id:
        return None

    opponents = raw.get("opponents") or []
    team_a = ((opponents[0] or {}).get("opponent") or {}) if len(opponents) > 0 else {}
    team_b = ((opponents[1] or {}).get("opponent") or {}) if len(opponents) > 1 else {}
    results = {r.get("team_id"): r.get("score") for r in (raw.get("results") or [])}

    status_map = {"running": "live", "not_started": "upcoming", "finished": "ended", "canceled": "ended"}
    status = status_map.get(raw.get("status"), "upcoming")

    games = raw.get("games") or []
    live_seconds = 0
    live_map_number = 0
    if status == "live":
        now_epoch = int(datetime.now(timezone.utc).timestamp())
        for game in games:
            if game.get("status") == "running" and game.get("begin_at"):
                started = _parse_iso(game["begin_at"])
                if started:
                    live_seconds = max(0, now_epoch - started)
                live_map_number = _to_int(game.get("position"), 0)
                break

    league = raw.get("league") or {}
    serie = raw.get("serie") or {}
    league_name = (league.get("name") or "").strip()
    serie_name = (serie.get("full_name") or serie.get("name") or "").strip()
    combined_name = league_name
    if serie_name and serie_name.lower() not in league_name.lower():
        combined_name = f"{league_name} - {serie_name}".strip(" -")

    map_summaries = []
    for game in games:
        winner = game.get("winner") or {}
        map_summaries.append(
            {
                "position": _to_int(game.get("position"), 0),
                "status": game.get("status") or "not_started",
                "winner_id": winner.get("id"),
            }
        )

    return {
        "match_id": match_id,
        "source": "pandascore",
        "status": status,
        "league_name": combined_name or "Unknown Tournament",
        "league_id": _to_int(league.get("id"), 0),
        "radiant_team": (team_a.get("name") or "").strip() or "TBD",
        "dire_team": (team_b.get("name") or "").strip() or "TBD",
        "radiant_team_id": team_a.get("id"),
        "dire_team_id": team_b.get("id"),
        "radiant_logo_url": (team_a.get("image_url") or "").strip(),
        "dire_logo_url": (team_b.get("image_url") or "").strip(),
        "radiant_score": results.get(team_a.get("id")),
        "dire_score": results.get(team_b.get("id")),
        "live_seconds": live_seconds,
        "live_map_number": live_map_number,
        "start_time": _parse_iso(raw.get("scheduled_at") or raw.get("begin_at")),
        "series_type": _series_type_from_games(_to_int(raw.get("number_of_games"), 0)),
        # PandaScore's free "Fixtures" plan does not expose live hero picks or
        # per-player stats (that needs the paid Historical/Real-time plan), so
        # lineups stay empty and the UI falls back to schedule/score info.
        "known_picks": 0,
        "lineup_available": False,
        "radiant_players": ["", "", "", "", ""],
        "dire_players": ["", "", "", "", ""],
        "radiant_heroes": ["", "", "", "", ""],
        "dire_heroes": ["", "", "", "", ""],
        "match_url": _stream_url(raw),
        "games": map_summaries,
    }


RECENT_ENDED_WINDOW_SECONDS = 3 * 60 * 60  # keep finished matches visible for 3 hours


def _build_live_feed() -> Dict:
    errors = []

    try:
        running_raw = _get_cached("running")
    except Exception as exc:  # noqa: BLE001
        running_raw = []
        errors.append(f"running: {exc}")

    try:
        upcoming_raw = _get_cached("upcoming")
    except Exception as exc:  # noqa: BLE001
        upcoming_raw = []
        errors.append(f"upcoming: {exc}")

    try:
        past_raw = _get_cached("past")
    except Exception as exc:  # noqa: BLE001
        past_raw = []
        errors.append(f"past: {exc}")

    now_epoch = int(datetime.now(timezone.utc).timestamp())
    matches = []

    for raw in running_raw:
        normalized = _normalize_match(raw)
        if normalized:
            matches.append(normalized)

    for raw in upcoming_raw:
        start = _parse_iso(raw.get("scheduled_at") or raw.get("begin_at"))
        if start and start - now_epoch > UPCOMING_WINDOW_SECONDS:
            continue
        normalized = _normalize_match(raw)
        if normalized:
            matches.append(normalized)

    for raw in past_raw:
        end_at = _parse_iso(raw.get("end_at"))
        if not end_at or now_epoch - end_at > RECENT_ENDED_WINDOW_SECONDS:
            continue
        normalized = _normalize_match(raw)
        if normalized:
            matches.append(normalized)

    status_rank = {"live": 0, "upcoming": 1, "ended": 2}
    matches.sort(
        key=lambda m: (
            status_rank.get(m.get("status"), 9),
            -_to_int(m.get("live_seconds"), 0) if m.get("status") == "live" else _to_int(m.get("start_time"), 0),
        )
    )

    return {
        "matches": matches,
        "meta": {
            "running_count": len(running_raw),
            "upcoming_count": len(upcoming_raw),
            "past_count": len(past_raw),
            "merged_count": len(matches),
            "errors": errors,
            "rate_limit": dict(_last_rate_limit),
        },
    }


@app.route("/health", methods=["GET"])
def health():
    return _cors_json(
        {
            "ok": True,
            "pandascore_configured": bool(PANDASCORE_TOKEN),
            "citoapi_configured": bool(CITOAPI_TOKEN),
        }
    )


@app.route("/api/live_matches", methods=["GET", "OPTIONS"])
def live_matches():
    if not PANDASCORE_TOKEN:
        return _cors_json({"matches": [], "error": "pandascore_token_not_configured"}, 500)

    try:
        payload = _build_live_feed()
    except Exception as exc:  # noqa: BLE001
        return _cors_json({"matches": [], "error": str(exc)}, 502)

    return _cors_json(payload)


@app.route("/api/finished_matches", methods=["GET", "OPTIONS"])
def finished_matches():
    """Refreshes the past-matches cache (best-effort) and returns archived rows."""
    if not PANDASCORE_TOKEN:
        return _cors_json({"matches": [], "error": "pandascore_token_not_configured"}, 500)

    try:
        _get_cached("past")
    except Exception:
        pass

    _init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM pandascore_finished_matches ORDER BY fetched_at DESC LIMIT 100"
    ).fetchall()
    conn.close()

    return _cors_json({"matches": [dict(row) for row in rows]})


@app.route("/api/hero_picks", methods=["GET", "OPTIONS"])
def hero_picks():
    """On-demand only: called when a user expands a live match's details.

    Never part of the polling loop, since CitoAPI's free plan caps out at
    500 calls/month and 10 calls/minute.
    """
    radiant_name = request.args.get("radiant", "").strip()
    dire_name = request.args.get("dire", "").strip()
    if not radiant_name or not dire_name:
        return _cors_json({"available": False, "error": "missing radiant/dire query params"}, 400)

    if not CITOAPI_TOKEN:
        return _cors_json({"available": False, "error": "citoapi_token_not_configured"})

    try:
        result = _citoapi_hero_picks(radiant_name, dire_name)
    except Exception as exc:  # noqa: BLE001
        return _cors_json({"available": False, "error": str(exc)})

    return _cors_json(result)


_init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=False, threaded=True)