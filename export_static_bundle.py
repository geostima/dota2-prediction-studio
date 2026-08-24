import json
from pathlib import Path
from datetime import datetime, timezone

from dota_predictor_advanced import DotaPredictionV2, init_advanced_db

OUT_FILE = Path("standalone_site/model_bundle.json")


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
        "player_hero_snapshot": snapshot,
        "last_train_metrics": predictor.last_train_metrics,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(payload), encoding="utf-8")
    print(f"Wrote static model bundle to {OUT_FILE}")


if __name__ == "__main__":
    main()
