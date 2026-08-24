import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone

from dota_predictor_advanced import DotaPredictionV2, init_advanced_db, DB_NAME

OUT_FILE = Path("standalone_site/model_bundle.json")


def build_team_rosters():
    conn = sqlite3.connect(DB_NAME)
    rows = conn.execute(
        """
        SELECT team_name, name, personaname
        FROM pro_players
        WHERE team_name IS NOT NULL AND TRIM(team_name) != ''
        """
    ).fetchall()
    conn.close()

    rosters = {}
    for team_name, name, personaname in rows:
        if not team_name:
            continue

        team = team_name.strip()
        player = (personaname or name or "").strip()
        if not player:
            continue

        if team not in rosters:
            rosters[team] = []

        if player not in rosters[team]:
            rosters[team].append(player)

    # Keep payload compact and deterministic.
    compact = {}
    for team, players in rosters.items():
        compact[team] = players[:10]

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
