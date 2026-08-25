"""One-shot snapshot fetcher run on a schedule by GitHub Actions (see
.github/workflows/update-live-data.yml) — NOT a running server.

This keeps the whole project a single static website with zero paid hosting:
API tokens live only as GitHub Actions secrets, this script calls PandaScore
(and, sparingly, CitoAPI) and writes plain JSON files under data/, which the
Action commits back to the repo. standalone_site/app.js then fetches that
JSON straight from raw.githubusercontent.com — no backend, no server, no key
ever reaches the browser.

Run locally for testing with PANDASCORE_API_TOKEN (and optionally
CITOAPI_API_KEY) set as environment variables:
    python scripts/fetch_live_snapshot.py
"""
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
LIVE_MATCHES_PATH = DATA_DIR / "live_matches.json"
CITOAPI_STATE_PATH = DATA_DIR / "citoapi_state.json"
FINISHED_MATCHES_PATH = DATA_DIR / "pandascore_finished_matches.jsonl"

PANDASCORE_BASE_URL = "https://api.pandascore.co"
PANDASCORE_TOKEN = os.environ.get("PANDASCORE_API_TOKEN", "").strip()
CITOAPI_BASE_URL = "https://api.citoapi.com/api/v1"
CITOAPI_TOKEN = os.environ.get("CITOAPI_API_KEY", "").strip()
REQUEST_TIMEOUT = 15

UPCOMING_WINDOW_SECONDS = 6 * 60 * 60
RECENT_ENDED_WINDOW_SECONDS = 3 * 60 * 60

# CitoAPI's free plan allows only 500 calls/month and 10/minute. This script
# runs roughly every 10 minutes, so hero picks are attempted at most once
# every CITOAPI_MIN_INTERVAL_SECONDS to keep monthly usage far under the cap
# (worst case ~6 attempts/day x 2 calls = ~360/month).
CITOAPI_MIN_INTERVAL_SECONDS = 4 * 60 * 60
CITOAPI_MONTHLY_CAP = 400
CITOAPI_MAX_MATCHES_PER_ATTEMPT = 2

_pandascore_session = requests.Session()
if PANDASCORE_TOKEN:
    _pandascore_session.headers.update({"Authorization": f"Bearer {PANDASCORE_TOKEN}"})

_citoapi_session = requests.Session()
if CITOAPI_TOKEN:
    _citoapi_session.headers.update({"x-api-key": CITOAPI_TOKEN})


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


def _pandascore_get(path: str, params: Optional[Dict] = None) -> List[Dict]:
    response = _pandascore_session.get(f"{PANDASCORE_BASE_URL}{path}", params=params, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    payload = response.json()
    return payload if isinstance(payload, list) else []


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

    map_summaries = [
        {
            "position": _to_int(game.get("position"), 0),
            "status": game.get("status") or "not_started",
            "winner_id": (game.get("winner") or {}).get("id"),
        }
        for game in games
    ]

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
        "known_picks": 0,
        "lineup_available": False,
        "radiant_players": ["", "", "", "", ""],
        "dire_players": ["", "", "", "", ""],
        "radiant_heroes": ["", "", "", "", ""],
        "dire_heroes": ["", "", "", "", ""],
        "match_url": _stream_url(raw),
        "games": map_summaries,
    }


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


def _load_citoapi_state() -> Dict:
    if CITOAPI_STATE_PATH.exists():
        try:
            return json.loads(CITOAPI_STATE_PATH.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            pass
    return {"month_key": "", "calls_this_month": 0, "last_attempt_at": 0}


def _save_citoapi_state(state: Dict):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CITOAPI_STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _enrich_with_hero_picks(matches: List[Dict], errors: List[str]) -> Dict:
    """Best-effort, heavily rate-limited hero-pick lookup for a few live matches."""
    state = _load_citoapi_state()
    month_key = datetime.now(timezone.utc).strftime("%Y-%m")
    if state.get("month_key") != month_key:
        state = {"month_key": month_key, "calls_this_month": 0, "last_attempt_at": 0}

    live_matches = [m for m in matches if m["status"] == "live"][:CITOAPI_MAX_MATCHES_PER_ATTEMPT]

    if not CITOAPI_TOKEN or not live_matches:
        return state

    since_last = time.time() - state.get("last_attempt_at", 0)
    if since_last < CITOAPI_MIN_INTERVAL_SECONDS:
        return state
    if state.get("calls_this_month", 0) >= CITOAPI_MONTHLY_CAP:
        return state

    state["last_attempt_at"] = time.time()

    try:
        response = _citoapi_session.get(f"{CITOAPI_BASE_URL}/dota2/matches/live", timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        state["calls_this_month"] = state.get("calls_this_month", 0) + 1
        cito_live = (response.json().get("data") or {}).get("matches") or []
    except Exception as exc:  # noqa: BLE001
        errors.append(f"citoapi live list: {exc}")
        return state

    for match in live_matches:
        if state.get("calls_this_month", 0) >= CITOAPI_MONTHLY_CAP:
            break

        candidate = next(
            (
                c
                for c in cito_live
                if (
                    _teams_fuzzy_match(c.get("team1Name") or "", match["radiant_team"])
                    and _teams_fuzzy_match(c.get("team2Name") or "", match["dire_team"])
                )
                or (
                    _teams_fuzzy_match(c.get("team1Name") or "", match["dire_team"])
                    and _teams_fuzzy_match(c.get("team2Name") or "", match["radiant_team"])
                )
            ),
            None,
        )
        if not candidate:
            continue

        try:
            resp = _citoapi_session.get(
                f"{CITOAPI_BASE_URL}/dota2/matches/{candidate.get('id')}/player-stats",
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            state["calls_this_month"] = state.get("calls_this_month", 0) + 1
            rows = resp.json().get("data") or []
        except Exception as exc:  # noqa: BLE001
            errors.append(f"citoapi player-stats {candidate.get('id')}: {exc}")
            continue

        if not rows:
            continue

        game_ids = [r.get("gameId") for r in rows if r.get("gameId")]
        latest_game_id = max(game_ids, default=None)
        current_rows = [r for r in rows if r.get("gameId") == latest_game_id] if latest_game_id else rows

        radiant_rows = [r for r in current_rows if r.get("isRadiant") is True]
        dire_rows = [r for r in current_rows if r.get("isRadiant") is False]
        if radiant_rows and not _teams_fuzzy_match(radiant_rows[0].get("teamName", ""), match["radiant_team"]):
            radiant_rows, dire_rows = dire_rows, radiant_rows

        radiant_players = [r.get("playerName") or "" for r in radiant_rows][:5]
        radiant_heroes = [r.get("heroName") or "" for r in radiant_rows][:5]
        dire_players = [r.get("playerName") or "" for r in dire_rows][:5]
        dire_heroes = [r.get("heroName") or "" for r in dire_rows][:5]

        match["radiant_players"] = (radiant_players + [""] * 5)[:5]
        match["dire_players"] = (dire_players + [""] * 5)[:5]
        match["radiant_heroes"] = (radiant_heroes + [""] * 5)[:5]
        match["dire_heroes"] = (dire_heroes + [""] * 5)[:5]
        match["known_picks"] = len([h for h in radiant_heroes + dire_heroes if h])
        match["lineup_available"] = match["known_picks"] > 0

    return state


def _append_finished_matches(raw_matches: List[Dict]):
    finished = [raw for raw in raw_matches if raw.get("status") == "finished"]
    if not finished:
        return

    existing_ids = set()
    if FINISHED_MATCHES_PATH.exists():
        with FINISHED_MATCHES_PATH.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    existing_ids.add(json.loads(line).get("match_id"))
                except ValueError:
                    continue

    new_rows = []
    for raw in finished:
        match_id = raw.get("id")
        if match_id in existing_ids:
            continue

        opponents = raw.get("opponents") or []
        team_a = ((opponents[0] or {}).get("opponent") or {}) if len(opponents) > 0 else {}
        team_b = ((opponents[1] or {}).get("opponent") or {}) if len(opponents) > 1 else {}
        results = {r.get("team_id"): r.get("score") for r in (raw.get("results") or [])}
        winner = raw.get("winner") or {}

        new_rows.append(
            {
                "match_id": match_id,
                "league_name": (raw.get("league") or {}).get("name"),
                "serie_name": (raw.get("serie") or {}).get("full_name"),
                "tournament_name": (raw.get("tournament") or {}).get("name"),
                "team_a_id": team_a.get("id"),
                "team_a_name": team_a.get("name"),
                "team_b_id": team_b.get("id"),
                "team_b_name": team_b.get("name"),
                "team_a_score": results.get(team_a.get("id")),
                "team_b_score": results.get(team_b.get("id")),
                "winner_id": winner.get("id"),
                "winner_name": winner.get("name"),
                "number_of_games": raw.get("number_of_games"),
                "begin_at": raw.get("begin_at"),
                "end_at": raw.get("end_at"),
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            }
        )

    if not new_rows:
        return

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with FINISHED_MATCHES_PATH.open("a", encoding="utf-8") as fh:
        for row in new_rows:
            fh.write(json.dumps(row) + "\n")


def main():
    errors = []

    if not PANDASCORE_TOKEN:
        raise SystemExit("PANDASCORE_API_TOKEN is required (set it as a GitHub Actions secret / env var)")

    try:
        running_raw = _pandascore_get("/dota2/matches/running", {"per_page": 50})
    except Exception as exc:  # noqa: BLE001
        running_raw = []
        errors.append(f"running: {exc}")

    try:
        upcoming_raw = _pandascore_get("/dota2/matches/upcoming", {"per_page": 50, "sort": "begin_at"})
    except Exception as exc:  # noqa: BLE001
        upcoming_raw = []
        errors.append(f"upcoming: {exc}")

    try:
        past_raw = _pandascore_get("/dota2/matches/past", {"per_page": 30, "sort": "-end_at"})
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

    citoapi_state = _enrich_with_hero_picks(matches, errors)
    _save_citoapi_state(citoapi_state)
    _append_finished_matches(past_raw)

    status_rank = {"live": 0, "upcoming": 1, "ended": 2}
    matches.sort(
        key=lambda m: (
            status_rank.get(m.get("status"), 9),
            -_to_int(m.get("live_seconds"), 0) if m.get("status") == "live" else _to_int(m.get("start_time"), 0),
        )
    )

    snapshot = {
        "generated_at": now_epoch,
        "generated_at_iso": datetime.now(timezone.utc).isoformat(),
        "matches": matches,
        "meta": {
            "running_count": len(running_raw),
            "upcoming_count": len(upcoming_raw),
            "past_count": len(past_raw),
            "citoapi_calls_this_month": citoapi_state.get("calls_this_month", 0),
            "errors": errors,
        },
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LIVE_MATCHES_PATH.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    print(f"Wrote {len(matches)} matches to {LIVE_MATCHES_PATH}")


if __name__ == "__main__":
    main()
