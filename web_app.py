from datetime import datetime
from threading import Lock

from flask import Flask, jsonify, render_template, request

from dota_predictor_advanced import DotaPredictionV2, init_advanced_db

app = Flask(__name__)
model_lock = Lock()
state = {
    "predictor": None,
    "ready": False,
    "training": False,
    "last_error": "",
    "last_metrics": {},
}


def _get_or_create_predictor():
    if state["predictor"] is None:
        init_advanced_db()
        state["predictor"] = DotaPredictionV2()
        state["ready"] = bool(state["predictor"].is_trained)
        if state["predictor"].last_train_metrics:
            state["last_metrics"] = state["predictor"].last_train_metrics
    return state["predictor"]


def _train_model(refresh_data=False, match_limit=400, min_matches=120):
    predictor = _get_or_create_predictor()

    state["training"] = True
    state["last_error"] = ""

    try:
        if refresh_data:
            predictor.refresh_reference_data()
            predictor.fetch_pro_matches(limit=match_limit, max_workers=6)

        trained = predictor.train(min_matches=min_matches)
        state["ready"] = bool(trained)
        state["last_metrics"] = predictor.last_train_metrics

        if not trained:
            state["last_error"] = (
                "Training did not finish. Add more cached matches or reduce minimum required matches."
            )

        return bool(trained)
    except Exception as exc:
        state["ready"] = False
        state["last_error"] = str(exc)
        return False
    finally:
        state["training"] = False


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/status", methods=["GET"])
def get_status():
    with model_lock:
        predictor = _get_or_create_predictor()
        hero_count = len(predictor.hero_name_to_id)
        player_count = len(predictor.player_name_to_id)

        return jsonify(
            {
                "ready": state["ready"],
                "training": state["training"],
                "last_error": state["last_error"],
                "hero_count": hero_count,
                "player_count": player_count,
                "metrics": state["last_metrics"],
            }
        )


@app.route("/api/options", methods=["GET"])
def get_options():
    with model_lock:
        predictor = _get_or_create_predictor()

        heroes = sorted(predictor.hero_name_to_id.keys())
        players = sorted(predictor.player_name_to_id.keys())[:4000]

        return jsonify({"heroes": heroes, "players": players})


@app.route("/api/train", methods=["POST"])
def train_model():
    payload = request.get_json(silent=True) or {}
    refresh_data = bool(payload.get("refresh_data", False))
    match_limit = int(payload.get("match_limit", 400))
    min_matches = int(payload.get("min_matches", 120))

    if match_limit < 100:
        match_limit = 100
    if match_limit > 2000:
        match_limit = 2000

    if min_matches < 40:
        min_matches = 40
    if min_matches > 2000:
        min_matches = 2000

    with model_lock:
        trained = _train_model(
            refresh_data=refresh_data,
            match_limit=match_limit,
            min_matches=min_matches,
        )

        return jsonify(
            {
                "ok": trained,
                "ready": state["ready"],
                "last_error": state["last_error"],
                "metrics": state["last_metrics"],
            }
        )


@app.route("/api/predict", methods=["POST"])
def predict():
    payload = request.get_json(silent=True) or {}

    radiant_team = (payload.get("radiant_team") or "Radiant").strip() or "Radiant"
    dire_team = (payload.get("dire_team") or "Dire").strip() or "Dire"

    radiant_players = payload.get("radiant_players") or []
    dire_players = payload.get("dire_players") or []
    radiant_heroes = payload.get("radiant_heroes") or []
    dire_heroes = payload.get("dire_heroes") or []

    if len(radiant_players) != 5 or len(dire_players) != 5:
        return jsonify({"error": "Each side must include exactly 5 player names."}), 400

    if len(radiant_heroes) != 5 or len(dire_heroes) != 5:
        return jsonify({"error": "Each side must include exactly 5 hero names."}), 400

    with model_lock:
        predictor = _get_or_create_predictor()
        if not state["ready"]:
            return (
                jsonify(
                    {
                        "error": "Model is not trained yet. Use Retrain in the UI first.",
                        "last_error": state["last_error"],
                    }
                ),
                400,
            )

        result = predictor.predict(
            radiant_hero_names=radiant_heroes,
            dire_hero_names=dire_heroes,
            radiant_player_names=radiant_players,
            dire_player_names=dire_players,
        )

    if "error" in result:
        return jsonify(result), 400

    return jsonify(
        {
            "radiant_team": radiant_team,
            "dire_team": dire_team,
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "prediction": result,
        }
    )


if __name__ == "__main__":
    with model_lock:
        _train_model(refresh_data=False, match_limit=400, min_matches=120)
    app.run(host="0.0.0.0", port=5000, debug=False)
