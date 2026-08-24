from datetime import datetime
from threading import Lock
import sqlite3

from flask import Flask, jsonify, render_template, request

from dota_predictor_advanced import DB_NAME, DotaPredictionV2, init_advanced_db

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


def _resolve_live_team(player_obj):
    if "isRadiant" in player_obj:
        return "radiant" if bool(player_obj.get("isRadiant")) else "dire"

    team_value = player_obj.get("team")
    if team_value in (0, "0", "radiant", "Radiant"):
        return "radiant"
    if team_value in (1, "1", "dire", "Dire"):
        return "dire"

    slot = player_obj.get("player_slot")
    if isinstance(slot, int):
        return "radiant" if slot < 128 else "dire"

    return None


def _pad_to_five(items):
    output = list(items[:5])
    while len(output) < 5:
        output.append("")
    return output


def _to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


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


@app.route("/api/live_matches", methods=["GET"])
def get_live_matches():
    limit = request.args.get("limit", default=20, type=int) or 20
    if limit < 1:
        limit = 1
    if limit > 50:
        limit = 50

    with model_lock:
        predictor = _get_or_create_predictor()

        conn = sqlite3.connect(DB_NAME)
        hero_rows = conn.execute("SELECT id, localized_name FROM heroes").fetchall()
        player_rows = conn.execute("SELECT account_id, name, personaname FROM pro_players").fetchall()
        conn.close()

        hero_id_to_name = {int(hero_id): localized_name for hero_id, localized_name in hero_rows if localized_name}
        account_id_to_name = {}
        for account_id, name, personaname in player_rows:
            label = (name or "").strip() or (personaname or "").strip()
            if label:
                account_id_to_name[int(account_id)] = label

        try:
            response = predictor.session.get("https://api.opendota.com/api/live", timeout=10)
            response.raise_for_status()
            payload = response.json() or []
        except Exception as exc:
            return jsonify({"error": f"Failed to fetch live matches: {exc}", "matches": []}), 502

        live_matches = []
        for match in payload:
            match_id = int(match.get("match_id") or 0)
            if not match_id:
                continue

            match_players = match.get("players") or []
            radiant_rows = []
            dire_rows = []

            for player in match_players:
                side = _resolve_live_team(player)
                if side not in ("radiant", "dire"):
                    continue

                account_id = int(player.get("account_id") or 0)
                hero_id = int(player.get("hero_id") or 0)
                slot = _to_int(player.get("player_slot"), 999)

                player_name = (
                    (player.get("name") or "").strip()
                    or (player.get("personaname") or "").strip()
                    or account_id_to_name.get(account_id, "")
                    or (f"Player {account_id}" if account_id else "")
                )
                hero_name = hero_id_to_name.get(hero_id, "")

                if side == "radiant":
                    radiant_rows.append((slot, player_name, hero_name))
                else:
                    dire_rows.append((slot, player_name, hero_name))

            radiant_rows.sort(key=lambda row: row[0])
            dire_rows.sort(key=lambda row: row[0])

            radiant_players = [row[1] for row in radiant_rows]
            radiant_heroes = [row[2] for row in radiant_rows]
            dire_players = [row[1] for row in dire_rows]
            dire_heroes = [row[2] for row in dire_rows]

            if len(radiant_players) == 0 or len(dire_players) == 0:
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
            scoreboard = match.get("scoreboard") or {}
            live_seconds = _to_int(scoreboard.get("duration"), 0)
            start_time = _to_int(match.get("start_time"), 0)
            radiant_score = _to_int(match.get("radiant_score"), -1)
            dire_score = _to_int(match.get("dire_score"), -1)
            known_picks = len([h for h in radiant_heroes + dire_heroes if h])

            if live_seconds > 0:
                match_status = "live"
            elif start_time > int(datetime.utcnow().timestamp()):
                match_status = "upcoming"
            else:
                match_status = "draft"

            live_matches.append(
                {
                    "match_id": match_id,
                    "label": (
                        f"{radiant_team} vs {dire_team}"
                        + (f" | {league_name}" if league_name else "")
                        + (" | draft in progress" if known_picks < 10 else "")
                    ),
                    "status": match_status,
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
                    "series_id": _to_int(match.get("series_id"), 0),
                    "league_id": _to_int(match.get("league_id"), 0),
                    "radiant_players": _pad_to_five(radiant_players),
                    "dire_players": _pad_to_five(dire_players),
                    "radiant_heroes": _pad_to_five(radiant_heroes),
                    "dire_heroes": _pad_to_five(dire_heroes),
                    "league_name": league_name,
                    "known_picks": known_picks,
                }
            )

            if len(live_matches) >= limit:
                break

        return jsonify({"matches": live_matches})


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
