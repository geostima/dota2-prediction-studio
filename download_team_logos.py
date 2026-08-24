"""Download logos for active tier 1-3 pro teams into the repo so the static site never hotlinks.

A team is kept when it is recently active and rated by OpenDota, or when it appears in the exported
model bundle rosters. Everything else falls back to the placeholder logo in the browser.

Usage:
    python download_team_logos.py --min-rating 1000 --active-days 400 --limit 250 --prune
"""

import argparse
import io
import json
import re
import time
from pathlib import Path

import requests

TEAMS_API = "https://api.opendota.com/api/teams"
PRO_MATCHES_API = "https://api.opendota.com/api/proMatches"
STRATZ_LOGO_TEMPLATE = "https://cdn.stratz.com/images/dota2/teams/{team_id}.png"
ASSETS_DIR = Path("standalone_site/assets/teams")
OVERRIDES_FILE = Path("standalone_site/team_logo_overrides.json")
BUNDLE_FILE = Path("standalone_site/model_bundle.json")
REQUEST_TIMEOUT = 20
MAX_PIXELS = 128


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return slug or "team"


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def shrink_png(raw: bytes) -> bytes:
    """Downscale to icon size when Pillow is installed; otherwise keep the original bytes."""
    try:
        from PIL import Image
    except ImportError:
        return raw

    try:
        with Image.open(io.BytesIO(raw)) as image:
            icon = image.convert("RGBA")
            icon.thumbnail((MAX_PIXELS, MAX_PIXELS), Image.LANCZOS)
            buffer = io.BytesIO()
            icon.save(buffer, format="PNG", optimize=True)
            return buffer.getvalue()
    except OSError:
        return raw


def download_logo(session: requests.Session, url: str, dest: Path) -> bool:
    try:
        response = session.get(url, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
    except requests.RequestException:
        return False

    content_type = response.headers.get("Content-Type", "")
    if "image" not in content_type:
        return False

    dest.write_bytes(shrink_png(response.content))
    return True


def bundle_team_names() -> set:
    if not BUNDLE_FILE.exists():
        return set()
    try:
        bundle = json.loads(BUNDLE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return set()
    return {normalize(name) for name in (bundle.get("team_rosters") or {})}


def recent_pro_teams(session: requests.Session) -> list:
    """Currently active orgs, since /api/teams omits several of them."""
    try:
        matches = session.get(PRO_MATCHES_API, timeout=REQUEST_TIMEOUT).json()
    except (requests.RequestException, ValueError):
        return []

    found = {}
    for match in matches if isinstance(matches, list) else []:
        for side in ("radiant", "dire"):
            team_id = int(match.get(f"{side}_team_id") or 0)
            name = str(match.get(f"{side}_name") or "").strip()
            if team_id > 0 and name:
                found.setdefault(team_id, {"team_id": team_id, "name": name})
    return list(found.values())


def select_teams(teams, min_rating: int, active_days: int, limit: int) -> list:
    cutoff = time.time() - active_days * 86400
    rostered = bundle_team_names()

    scored = []
    for team in teams:
        name = str(team.get("name") or "").strip()
        if not name:
            continue

        rating = float(team.get("rating") or 0)
        last_match = float(team.get("last_match_time") or 0)
        games = int(team.get("wins") or 0) + int(team.get("losses") or 0)
        active_tier = last_match >= cutoff and rating >= min_rating and games >= 20

        if active_tier or normalize(name) in rostered:
            scored.append((rating, team))

    scored.sort(key=lambda item: item[0], reverse=True)
    return [team for _, team in scored[:limit]]


def existing_manual_entries() -> dict:
    """Hand-added mappings are kept as long as their image is still in the repo."""
    if not OVERRIDES_FILE.exists():
        return {}
    try:
        current = json.loads(OVERRIDES_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}

    kept = {}
    for name, rel_path in current.items():
        if isinstance(rel_path, str) and (Path("standalone_site") / rel_path).exists():
            kept[name] = rel_path
    return kept


def main() -> None:
    parser = argparse.ArgumentParser(description="Download tier 1-3 team logos for the static site.")
    parser.add_argument("--min-rating", type=int, default=1000, help="Minimum OpenDota rating to count as tier 1-3.")
    parser.add_argument("--active-days", type=int, default=400, help="Only keep teams with a match in this window.")
    parser.add_argument("--limit", type=int, default=250, help="Max teams to keep, highest rated first.")
    parser.add_argument("--prune", action="store_true", help="Delete stored logos that are no longer mapped.")
    args = parser.parse_args()

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers.update({"User-Agent": "Dota2-PredictionModel/logo-fetch"})

    payload = session.get(TEAMS_API, timeout=REQUEST_TIMEOUT).json()
    selected = select_teams(payload if isinstance(payload, list) else [], args.min_rating, args.active_days, args.limit)

    seen_ids = {int(team.get("team_id") or 0) for team in selected}
    for team in recent_pro_teams(session):
        if team["team_id"] not in seen_ids:
            selected.append(team)
            seen_ids.add(team["team_id"])

    mapping = {}
    manual = existing_manual_entries()
    downloaded = 0

    for team in selected:
        name = str(team.get("name")).strip()
        slug = slugify(name)
        dest = ASSETS_DIR / f"{slug}.png"
        rel_path = f"assets/teams/{slug}.png"

        if dest.exists():
            mapping[name] = rel_path
            continue

        sources = []
        team_id = int(team.get("team_id") or 0)
        if team_id > 0:
            sources.append(STRATZ_LOGO_TEMPLATE.format(team_id=team_id))
        opendota_url = str(team.get("logo_url") or "").strip()
        if opendota_url:
            sources.append(opendota_url)

        if any(download_logo(session, url, dest) for url in sources):
            mapping[name] = rel_path
            downloaded += 1
            print(f"saved {name} -> {rel_path}")

    mapping.update(manual)

    OVERRIDES_FILE.write_text(
        json.dumps(mapping, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    removed = 0
    if args.prune:
        keep = set(mapping.values())
        for path in ASSETS_DIR.glob("*.png"):
            if f"assets/teams/{path.name}" not in keep:
                path.unlink()
                removed += 1

    total_bytes = sum(p.stat().st_size for p in ASSETS_DIR.iterdir() if p.is_file())
    print(
        f"Done. Teams kept: {len(mapping)}. Downloaded: {downloaded}. Pruned: {removed}. "
        f"Assets size: {total_bytes / 1024 / 1024:.2f} MB."
    )


if __name__ == "__main__":
    main()
