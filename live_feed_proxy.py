import re
from typing import Dict, List

import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify

app = Flask(__name__)

REQUEST_TIMEOUT = 12
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)


def _cors_json(payload, status=200):
    response = jsonify(payload)
    response.status_code = status
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def _slug_to_team(slug_text: str) -> str:
    words = [w for w in slug_text.split("-") if w]
    return " ".join(words).strip().title() if words else "Unknown Team"


def _to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _pad_to_five(items):
    output = list(items[:5])
    while len(output) < 5:
        output.append("")
    return output


def fetch_opendota_matches(limit=60) -> List[Dict]:
    r = requests.get("https://api.opendota.com/api/live", timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    payload = r.json() or []

    out = []
    for match in payload:
        match_id = _to_int(match.get("match_id"), 0)
        if not match_id:
            continue

        radiant_team_obj = match.get("radiant_team") or {}
        dire_team_obj = match.get("dire_team") or {}
        radiant_team = (
            (radiant_team_obj.get("team_name") or "").strip()
            or (match.get("radiant_name") or "").strip()
            or "Radiant"
        )
        dire_team = (
            (dire_team_obj.get("team_name") or "").strip()
            or (match.get("dire_name") or "").strip()
            or "Dire"
        )

        league_name = (match.get("league_name") or "").strip()
        league_id = _to_int(match.get("league_id"), 0)

        if radiant_team.lower() == "radiant" or dire_team.lower() == "dire":
            continue
        if not league_name and league_id <= 0:
            continue

        scoreboard = match.get("scoreboard") or {}
        live_seconds = _to_int(scoreboard.get("duration"), 0)
        start_time = _to_int(match.get("start_time"), 0)
        radiant_score = _to_int(match.get("radiant_score"), -1)
        dire_score = _to_int(match.get("dire_score"), -1)

        status = "draft"
        if live_seconds > 0:
            status = "live"

        players = match.get("players") or []
        lineup_available = len(players) > 0

        out.append(
            {
                "match_id": match_id,
                "source": "opendota",
                "status": status,
                "league_name": league_name,
                "league_id": league_id,
                "radiant_team": radiant_team,
                "dire_team": dire_team,
                "radiant_logo_url": (
                    (radiant_team_obj.get("logo_url") or "").strip()
                    or (radiant_team_obj.get("logo") or "").strip()
                ),
                "dire_logo_url": (
                    (dire_team_obj.get("logo_url") or "").strip()
                    or (dire_team_obj.get("logo") or "").strip()
                ),
                "radiant_score": None if radiant_score < 0 else radiant_score,
                "dire_score": None if dire_score < 0 else dire_score,
                "live_seconds": live_seconds,
                "start_time": start_time,
                "series_type": _to_int(match.get("series_type"), 0),
                "known_picks": 0,
                "lineup_available": lineup_available,
                "radiant_players": _pad_to_five([]),
                "dire_players": _pad_to_five([]),
                "radiant_heroes": _pad_to_five([]),
                "dire_heroes": _pad_to_five([]),
                "match_url": "",
            }
        )

    return out[:limit]


def fetch_cyberscore_matches(limit=60) -> List[Dict]:
    r = requests.get(
        "https://cyberscore.live/en/",
        headers={"User-Agent": UA},
        timeout=REQUEST_TIMEOUT,
    )
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    out = []
    seen = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "/en/matches/" not in href:
            continue

        full_url = href if href.startswith("http") else f"https://cyberscore.live{href}"
        slug = href.rstrip("/").split("/")[-1]
        if "-vs-" not in slug:
            continue
        if slug in seen:
            continue
        seen.add(slug)

        text = " ".join(a.stripped_strings)
        if "TIER-" not in text and "tier-" not in text.lower():
            continue

        parts = slug.split("-vs-")
        if len(parts) < 2:
            continue
        left_slug = parts[0]
        right_plus_id = parts[1]
        right_slug = re.sub(r"-\d+$", "", right_plus_id)
        match_id = _to_int(re.search(r"(\d+)$", slug).group(1) if re.search(r"(\d+)$", slug) else 0, 0)

        league_name = ""
        league_match = re.search(r"TIER-\d+\s+(.+)$", text, flags=re.IGNORECASE)
        if league_match:
            league_name = league_match.group(1).strip()

        status = "upcoming"
        if text.startswith("LIVE") or text.startswith("WAIT"):
            status = "live"
        elif "Draft" in text or "draft" in text:
            status = "draft"

        time_match = re.search(r"(\d{1,2}:\d{2})", text)
        live_seconds = 0
        if time_match:
            mins, secs = time_match.group(1).split(":")
            live_seconds = int(mins) * 60 + int(secs)

        score_match = re.search(r"(\d+)\s*-\s*(\d+)", text)
        rad_score = _to_int(score_match.group(1), -1) if score_match else -1
        dire_score = _to_int(score_match.group(2), -1) if score_match else -1

        out.append(
            {
                "match_id": match_id if match_id > 0 else _to_int(abs(hash(slug)) % 10_000_000, 0),
                "source": "cyberscore",
                "status": status,
                "league_name": league_name,
                "league_id": 0,
                "radiant_team": _slug_to_team(left_slug),
                "dire_team": _slug_to_team(right_slug),
                "radiant_logo_url": "",
                "dire_logo_url": "",
                "radiant_score": None if rad_score < 0 else rad_score,
                "dire_score": None if dire_score < 0 else dire_score,
                "live_seconds": live_seconds,
                "start_time": 0,
                "series_type": 1 if "BO3" in text else (2 if "BO5" in text else 0),
                "known_picks": 0,
                "lineup_available": False,
                "radiant_players": _pad_to_five([]),
                "dire_players": _pad_to_five([]),
                "radiant_heroes": _pad_to_five([]),
                "dire_heroes": _pad_to_five([]),
                "match_url": full_url,
            }
        )

        if len(out) >= limit:
            break

    return out


def merge_matches(primary: List[Dict], secondary: List[Dict], limit=80) -> List[Dict]:
    by_key: Dict[str, Dict] = {}

    for item in secondary:
        key = f"{item.get('radiant_team','').lower()}|{item.get('dire_team','').lower()}|{item.get('league_name','').lower()}"
        by_key[key] = item

    for item in primary:
        key = f"{item.get('radiant_team','').lower()}|{item.get('dire_team','').lower()}|{item.get('league_name','').lower()}"
        if key in by_key:
            existing = by_key[key]
            existing.update(
                {
                    "source": f"{existing.get('source','secondary')}+opendota",
                    "radiant_logo_url": item.get("radiant_logo_url") or existing.get("radiant_logo_url", ""),
                    "dire_logo_url": item.get("dire_logo_url") or existing.get("dire_logo_url", ""),
                    "live_seconds": item.get("live_seconds", 0),
                    "radiant_score": item.get("radiant_score"),
                    "dire_score": item.get("dire_score"),
                    "status": item.get("status", existing.get("status", "draft")),
                    "lineup_available": bool(item.get("lineup_available")) or bool(existing.get("lineup_available")),
                }
            )
        else:
            by_key[key] = item

    merged = list(by_key.values())
    status_rank = {"live": 0, "draft": 1, "upcoming": 2}
    merged.sort(
        key=lambda m: (
            status_rank.get(str(m.get("status", "draft")), 9),
            -_to_int(m.get("live_seconds"), 0),
        )
    )
    return merged[:limit]


@app.route("/health", methods=["GET"])
def health():
    return _cors_json({"ok": True})


@app.route("/api/live_matches", methods=["GET", "OPTIONS"])
def live_matches():
    if requests is None:
        return _cors_json({"matches": [], "error": "requests_not_available"}, 500)

    errors = []
    opendota_matches: List[Dict] = []
    cyberscore_matches: List[Dict] = []

    try:
        opendota_matches = fetch_opendota_matches(limit=80)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"opendota: {exc}")

    try:
        cyberscore_matches = fetch_cyberscore_matches(limit=80)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"cyberscore: {exc}")

    merged = merge_matches(opendota_matches, cyberscore_matches, limit=80)
    return _cors_json(
        {
            "matches": merged,
            "meta": {
                "opendota_count": len(opendota_matches),
                "cyberscore_count": len(cyberscore_matches),
                "merged_count": len(merged),
                "errors": errors,
            },
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=False)