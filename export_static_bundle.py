import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

import requests

from dota_predictor_advanced import DotaPredictionV2, init_advanced_db, DB_NAME

OUT_FILE = Path("standalone_site/model_bundle.json")


def parse_int_csv(csv_value):
    if not csv_value:
        return []
    return [int(x) for x in csv_value.split(",") if x.strip()]


def merge_roster(rosters, team_name, players, max_players=5):
    if not team_name or not players:
        return

    if team_name not in rosters:
        rosters[team_name] = []

    for player in players:
        player_name = (player or "").strip()
        if not player_name:
            continue
        if player_name not in rosters[team_name]:
            rosters[team_name].append(player_name)
        if len(rosters[team_name]) >= max_players:
            break


def fetch_recent_team_context(max_pages=8, timeout=10):
    team_id_to_name = {}
    team_id_to_match_ids = defaultdict(list)
    last_match_id = None

    for _ in range(max_pages):
        params = {"less_than_match_id": last_match_id} if last_match_id else None
        try:
            response = requests.get("https://api.opendota.com/api/proMatches", params=params, timeout=timeout)
            response.raise_for_status()
            page = response.json()
        except Exception:
            break

        if not page:
            break

        for row in page:
            match_id = int(row.get("match_id") or 0)
            r_id = int(row.get("radiant_team_id") or 0)
            d_id = int(row.get("dire_team_id") or 0)
            r_name = (row.get("radiant_name") or "").strip()
            d_name = (row.get("dire_name") or "").strip()

            if r_id > 0 and r_name:
                team_id_to_name[r_id] = r_name
                if match_id > 0 and len(team_id_to_match_ids[r_id]) < 5:
                    team_id_to_match_ids[r_id].append(match_id)
            if d_id > 0 and d_name:
                team_id_to_name[d_id] = d_name
                if match_id > 0 and len(team_id_to_match_ids[d_id]) < 5:
                    team_id_to_match_ids[d_id].append(match_id)

        ids = [int(x.get("match_id") or 0) for x in page if x.get("match_id")]
        if not ids:
            break
        last_match_id = min(ids)

    return team_id_to_name, team_id_to_match_ids


def fetch_team_roster_from_api(team_id, timeout=10):
    try:
        response = requests.get(f"https://api.opendota.com/api/teams/{team_id}/players", timeout=timeout)
        if response.status_code != 200:
            return []
        rows = response.json() or []
    except Exception:
        return []

    ranked = []
    for row in rows:
        games_played = int(row.get("games_played") or 0)
        name = (row.get("name") or row.get("personaname") or "").strip()
        if not name:
            continue
        ranked.append((games_played, name))

    ranked.sort(key=lambda x: (-x[0], x[1].lower()))

    roster = []
    for _, name in ranked:
        if name not in roster:
            roster.append(name)
        if len(roster) >= 5:
            break

    return roster


def fetch_team_roster_from_recent_matches(team_id, match_ids, account_to_name, timeout=10):
    if not match_ids:
        return []

    player_counts = defaultdict(int)

    for match_id in match_ids[:3]:
        try:
            response = requests.get(f"https://api.opendota.com/api/matches/{match_id}", timeout=timeout)
            if response.status_code != 200:
                continue
            details = response.json()
        except Exception:
            continue

        players = details.get("players") or []
        radiant_team_id = int(details.get("radiant_team_id") or 0)
        dire_team_id = int(details.get("dire_team_id") or 0)

        if radiant_team_id == team_id:
            side_players = [p for p in players if p.get("isRadiant") is True]
        elif dire_team_id == team_id:
            side_players = [p for p in players if p.get("isRadiant") is False]
        else:
            continue

        for p in side_players:
            account_id = int(p.get("account_id") or 0)
            display_name = (
                (p.get("personaname") or "").strip()
                or (p.get("name") or "").strip()
                or account_to_name.get(account_id, "")
            )
            if display_name:
                player_counts[display_name] += 1

    ordered = [name for name, _ in sorted(player_counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))]
    return ordered[:5]


def build_team_rosters():
    conn = sqlite3.connect(DB_NAME)

    # Display names by account ID for roster output.
    pro_name_rows = conn.execute(
        """
        SELECT account_id, name, personaname
        FROM pro_players
        WHERE account_id IS NOT NULL
        """
    ).fetchall()
    account_to_name = {}
    for account_id, name, personaname in pro_name_rows:
        account_id = int(account_id or 0)
        if account_id <= 0:
            continue
        display = (personaname or name or "").strip()
        if display:
            account_to_name[account_id] = display

    team_id_to_name, team_id_to_match_ids = fetch_recent_team_context(max_pages=8)

    # Primary source: most recent pro matches for each team.
    rosters = {}
    for team_id, team_name in team_id_to_name.items():
        roster = fetch_team_roster_from_recent_matches(
            team_id=team_id,
            match_ids=team_id_to_match_ids.get(team_id, []),
            account_to_name=account_to_name,
            timeout=10,
        )
        merge_roster(rosters, team_name, roster)

    # Secondary source: team API roster data to complete missing slots.
    for team_id, team_name in team_id_to_name.items():
        if len(rosters.get(team_name, [])) >= 5:
            continue

        roster = fetch_team_roster_from_api(team_id, timeout=10)
        merge_roster(rosters, team_name, roster)

    # Secondary source: infer active rosters from recent cached matches by team_id.
    match_rows = conn.execute(
        """
        SELECT start_time, radiant_team_id, dire_team_id, radiant_players, dire_players
        FROM matches
        ORDER BY start_time DESC
        """
    ).fetchall()

    team_player_counts = defaultdict(lambda: defaultdict(int))
    for _, radiant_team_id, dire_team_id, radiant_players_csv, dire_players_csv in match_rows:
        radiant_team_id = int(radiant_team_id or 0)
        dire_team_id = int(dire_team_id or 0)

        if radiant_team_id > 0 and radiant_team_id in team_id_to_name:
            for player_id in parse_int_csv(radiant_players_csv):
                if player_id > 0:
                    team_player_counts[radiant_team_id][player_id] += 1

        if dire_team_id > 0 and dire_team_id in team_id_to_name:
            for player_id in parse_int_csv(dire_players_csv):
                if player_id > 0:
                    team_player_counts[dire_team_id][player_id] += 1

    for team_id, counts in team_player_counts.items():
        team_name = team_id_to_name.get(team_id)
        if not team_name:
            continue
        if team_name in rosters:
            continue

        ordered_player_ids = [
            player_id for player_id, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ]

        players = []
        for player_id in ordered_player_ids:
            player_name = account_to_name.get(player_id)
            if player_name and player_name not in players:
                players.append(player_name)
            if len(players) >= 5:
                break

        if players:
            rosters[team_name] = players

    # Fallback: use pro_players team tags only if no active roster could be inferred.
    rows = conn.execute(
        """
        SELECT team_name, name, personaname
        FROM pro_players
        WHERE team_name IS NOT NULL AND TRIM(team_name) != ''
        """
    ).fetchall()
    conn.close()

    for team_name, name, personaname in rows:
        if not team_name:
            continue

        team = team_name.strip()
        player = (personaname or name or "").strip()
        if not player:
            continue

        merge_roster(rosters, team, [player])

    # Keep payload compact and deterministic.
    compact = {}
    for team, players in sorted(rosters.items(), key=lambda kv: kv[0].lower()):
        compact[team] = players[:5]

    return compact


def main():
    init_advanced_db()
    predictor = DotaPredictionV2()

    if not predictor.is_trained:
        trained = predictor.train(min_matches=120)
        if not trained:
            raise SystemExit("Model is not trained and training failed. Fetch more match data first.")

    coef = predictor.model.coef_[0].tolist()
    intercept = float(predictor.model.intercept_[0])

    snapshot = {
        f"{player_id}:{hero_id}": [int(wins), int(games)]
        for (player_id, hero_id), (wins, games) in predictor.player_hero_snapshot.items()
    }

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "num_heroes": int(predictor.num_heroes),
        "coef": coef,
        "intercept": intercept,
        "hero_name_to_id": predictor.hero_name_to_id,
        "player_name_to_id": predictor.player_name_to_id,
        "team_rosters": build_team_rosters(),
        "player_hero_snapshot": snapshot,
        "last_train_metrics": predictor.last_train_metrics,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(payload), encoding="utf-8")
    print(f"Wrote static model bundle to {OUT_FILE}")


if __name__ == "__main__":
    main()
