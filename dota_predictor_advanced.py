import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score
from urllib3.util.retry import Retry

DB_NAME = "advanced_dota.db"
API_BASE = "https://api.opendota.com/api"
REQUEST_TIMEOUT = 10
MODEL_STATE_FILE = "advanced_model_state.pkl"


def build_http_session():
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        backoff_factor=0.5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset(["GET"]),
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=20, pool_maxsize=20)
    session = requests.Session()
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def parse_int_csv(csv_value):
    if not csv_value:
        return []
    return [int(x) for x in csv_value.split(",") if x.strip()]


def chunked(items, chunk_size):
    for idx in range(0, len(items), chunk_size):
        yield items[idx : idx + chunk_size]


def init_advanced_db():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS heroes (
            id INTEGER PRIMARY KEY,
            name TEXT,
            localized_name TEXT
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pro_players (
            account_id INTEGER PRIMARY KEY,
            name TEXT,
            personaname TEXT,
            team_name TEXT
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS matches (
            match_id INTEGER PRIMARY KEY,
            start_time INTEGER,
            radiant_win INTEGER,
            radiant_team_id INTEGER,
            dire_team_id INTEGER,
            radiant_picks TEXT,
            dire_picks TEXT,
            radiant_players TEXT,
            dire_players TEXT
        )
        """
    )

    conn.commit()
    conn.close()


class DotaPredictionV2:
    def __init__(self):
        self.session = build_http_session()
        self.model = LogisticRegression(max_iter=2000, solver="liblinear")
        self.hero_name_to_id = {}
        self.player_name_to_id = {}
        self.num_heroes = 0
        self.is_trained = False
        self.player_hero_snapshot = {}
        self.last_train_metrics = {}
        self.load_local_dictionaries()
        self.load_model_state()

    def load_model_state(self):
        model_path = Path(MODEL_STATE_FILE)
        if not model_path.exists():
            return False

        try:
            with model_path.open("rb") as f:
                payload = pickle.load(f)

            model = payload.get("model")
            snapshot = payload.get("player_hero_snapshot")
            metrics = payload.get("last_train_metrics", {})

            if model is None or snapshot is None:
                return False

            expected_features = self.num_heroes + 3
            model_features = int(model.coef_.shape[1]) if hasattr(model, "coef_") else -1
            if model_features != expected_features:
                return False

            self.model = model
            self.player_hero_snapshot = snapshot
            self.last_train_metrics = metrics
            self.is_trained = True
            return True
        except Exception:
            return False

    def save_model_state(self):
        payload = {
            "model": self.model,
            "player_hero_snapshot": self.player_hero_snapshot,
            "last_train_metrics": self.last_train_metrics,
        }

        with Path(MODEL_STATE_FILE).open("wb") as f:
            pickle.dump(payload, f)

    def load_local_dictionaries(self):
        conn = sqlite3.connect(DB_NAME)
        hero_rows = conn.execute("SELECT id, localized_name FROM heroes").fetchall()
        pro_rows = conn.execute("SELECT account_id, name, personaname FROM pro_players").fetchall()
        conn.close()

        for hero_id, localized_name in hero_rows:
            if localized_name:
                self.hero_name_to_id[localized_name.strip().lower()] = int(hero_id)

        for account_id, name, personaname in pro_rows:
            if name:
                self.player_name_to_id[name.strip().lower()] = int(account_id)
            if personaname:
                self.player_name_to_id[personaname.strip().lower()] = int(account_id)

        if hero_rows:
            self.num_heroes = max(int(h[0]) for h in hero_rows) + 1

    def refresh_reference_data(self):
        print("[1/4] Refreshing hero and pro-player reference tables...")
        self._update_heroes()
        self._update_pro_players()
        self.load_local_dictionaries()

    def _update_heroes(self):
        response = self.session.get(f"{API_BASE}/heroes", timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        heroes = response.json()

        rows = [(h["id"], h.get("name", ""), h.get("localized_name", "")) for h in heroes]

        conn = sqlite3.connect(DB_NAME)
        conn.executemany(
            """
            INSERT OR REPLACE INTO heroes (id, name, localized_name)
            VALUES (?, ?, ?)
            """,
            rows,
        )
        conn.commit()
        conn.close()
        print(f"  -> Saved {len(rows)} heroes.")

    def _update_pro_players(self):
        response = self.session.get(f"{API_BASE}/proPlayers", timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        players = response.json()

        rows = []
        for p in players:
            account_id = p.get("account_id")
            if not account_id:
                continue
            rows.append(
                (
                    int(account_id),
                    p.get("name", ""),
                    p.get("personaname", ""),
                    p.get("team_name", ""),
                )
            )

        conn = sqlite3.connect(DB_NAME)
        conn.executemany(
            """
            INSERT OR REPLACE INTO pro_players (account_id, name, personaname, team_name)
            VALUES (?, ?, ?, ?)
            """,
            rows,
        )
        conn.commit()
        conn.close()
        print(f"  -> Saved {len(rows)} pro players.")

    def fetch_pro_matches(self, limit=300, max_workers=6):
        print(f"[2/4] Fetching up to {limit} pro matches and caching details...")

        candidate_ids = []
        last_match_id = None
        max_pages = 30

        # OpenDota proMatches is paginated (roughly 100 rows/page), so walk pages
        # until we collect enough IDs or run out of older pages.
        for _ in range(max_pages):
            params = {"less_than_match_id": last_match_id} if last_match_id else None
            response = self.session.get(
                f"{API_BASE}/proMatches",
                params=params,
                timeout=REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            page = response.json()

            if not page:
                break

            page_ids = [int(m["match_id"]) for m in page if m.get("match_id")]
            if not page_ids:
                break

            candidate_ids.extend(page_ids)
            last_match_id = min(page_ids)

            if len(candidate_ids) >= limit:
                break

        candidate_ids = candidate_ids[:limit]

        if not candidate_ids:
            print("  -> No match IDs returned by API.")
            return

        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()

        existing_ids = set()
        for id_chunk in chunked(candidate_ids, 900):
            placeholders = ",".join("?" for _ in id_chunk)
            query = f"SELECT match_id FROM matches WHERE match_id IN ({placeholders})"
            existing_ids.update(r[0] for r in cursor.execute(query, id_chunk).fetchall())

        missing_ids = [m_id for m_id in candidate_ids if m_id not in existing_ids]
        print(
            f"  -> Gathered {len(candidate_ids)} IDs across pages, "
            f"{len(existing_ids)} already cached, {len(missing_ids)} to fetch."
        )

        if not missing_ids:
            conn.close()
            return

        rows = []
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(self._fetch_single_match, m_id): m_id for m_id in missing_ids}
            for future in as_completed(futures):
                row = future.result()
                if row is not None:
                    rows.append(row)

        cursor.executemany(
            """
            INSERT OR REPLACE INTO matches (
                match_id, start_time, radiant_win, radiant_team_id, dire_team_id,
                radiant_picks, dire_picks, radiant_players, dire_players
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.commit()
        conn.close()

        print(f"  -> Cached {len(rows)} valid 5v5 matches.")

    def _fetch_single_match(self, match_id):
        try:
            response = self.session.get(f"{API_BASE}/matches/{match_id}", timeout=REQUEST_TIMEOUT)
            if response.status_code != 200:
                return None
            details = response.json()

            players = details.get("players") or []
            radiant_players = [p for p in players if p.get("isRadiant") is True]
            dire_players = [p for p in players if p.get("isRadiant") is False]

            if len(radiant_players) != 5 or len(dire_players) != 5:
                return None

            radiant_hero_ids = [int(p.get("hero_id") or 0) for p in radiant_players]
            dire_hero_ids = [int(p.get("hero_id") or 0) for p in dire_players]
            radiant_account_ids = [int(p.get("account_id") or 0) for p in radiant_players]
            dire_account_ids = [int(p.get("account_id") or 0) for p in dire_players]

            if any(h <= 0 for h in radiant_hero_ids + dire_hero_ids):
                return None

            return (
                int(match_id),
                int(details.get("start_time") or 0),
                1 if details.get("radiant_win") else 0,
                int(details.get("radiant_team_id") or 0),
                int(details.get("dire_team_id") or 0),
                ",".join(str(x) for x in radiant_hero_ids),
                ",".join(str(x) for x in dire_hero_ids),
                ",".join(str(x) for x in radiant_account_ids),
                ",".join(str(x) for x in dire_account_ids),
            )
        except Exception:
            return None

    def _build_draft_vector(self, radiant_heroes, dire_heroes):
        draft = np.zeros(self.num_heroes, dtype=np.float32)
        for hero_id in radiant_heroes:
            if 0 < hero_id < self.num_heroes:
                draft[hero_id] = 1.0
        for hero_id in dire_heroes:
            if 0 < hero_id < self.num_heroes:
                draft[hero_id] = -1.0
        return draft

    @staticmethod
    def _smoothed_wr(wins, games):
        return (wins + 1.0) / (games + 2.0)

    def _team_comfort(self, historical_stats, player_ids, hero_ids):
        values = []
        for player_id, hero_id in zip(player_ids, hero_ids):
            if player_id <= 0 or hero_id <= 0:
                values.append(0.5)
                continue

            wins, games = historical_stats.get((player_id, hero_id), (0, 0))
            values.append(self._smoothed_wr(wins, games))

        if not values:
            return 0.5
        return float(sum(values) / len(values))

    def _update_history(self, historical_stats, player_ids, hero_ids, did_win):
        for player_id, hero_id in zip(player_ids, hero_ids):
            if player_id <= 0 or hero_id <= 0:
                continue
            wins, games = historical_stats.get((player_id, hero_id), (0, 0))
            games += 1
            if did_win:
                wins += 1
            historical_stats[(player_id, hero_id)] = (wins, games)

    def _build_training_data(self, df):
        historical_stats = {}
        x_rows = []
        y_rows = []

        for row in df.itertuples(index=False):
            radiant_heroes = parse_int_csv(row.radiant_picks)
            dire_heroes = parse_int_csv(row.dire_picks)
            radiant_players = parse_int_csv(row.radiant_players)
            dire_players = parse_int_csv(row.dire_players)

            if len(radiant_heroes) != 5 or len(dire_heroes) != 5:
                continue

            if len(radiant_players) != 5:
                radiant_players = [0, 0, 0, 0, 0]
            if len(dire_players) != 5:
                dire_players = [0, 0, 0, 0, 0]

            rad_comfort = self._team_comfort(historical_stats, radiant_players, radiant_heroes)
            dire_comfort = self._team_comfort(historical_stats, dire_players, dire_heroes)

            draft = self._build_draft_vector(radiant_heroes, dire_heroes)
            extras = np.array(
                [rad_comfort, dire_comfort, rad_comfort - dire_comfort],
                dtype=np.float32,
            )
            x_rows.append(np.concatenate((draft, extras), dtype=np.float32))
            y_rows.append(int(row.radiant_win))

            self._update_history(historical_stats, radiant_players, radiant_heroes, did_win=bool(row.radiant_win))
            self._update_history(historical_stats, dire_players, dire_heroes, did_win=not bool(row.radiant_win))

        if not x_rows:
            return None, None, None

        return np.vstack(x_rows), np.array(y_rows, dtype=np.int32), historical_stats

    def train(self, min_matches=120):
        print("[3/4] Training supervised model...")
        conn = sqlite3.connect(DB_NAME)
        df = pd.read_sql_query(
            """
            SELECT start_time, radiant_win, radiant_picks, dire_picks, radiant_players, dire_players
            FROM matches
            ORDER BY start_time ASC
            """,
            conn,
        )
        conn.close()

        if len(df) < min_matches:
            self.last_train_metrics = {
                "status": "failed",
                "reason": "not_enough_cached_matches",
                "min_matches": int(min_matches),
                "cached_matches": int(len(df)),
            }
            print(f"  -> Need at least {min_matches} cached matches. Current: {len(df)}")
            return False

        x, y, snapshot = self._build_training_data(df)
        if x is None or len(x) < min_matches:
            self.last_train_metrics = {
                "status": "failed",
                "reason": "not_enough_valid_rows",
                "min_matches": int(min_matches),
                "valid_rows": 0 if x is None else int(len(x)),
            }
            print("  -> Not enough valid 5v5 rows after filtering.")
            return False

        split_idx = int(len(x) * 0.8)
        if split_idx < 20 or split_idx >= len(x):
            self.last_train_metrics = {
                "status": "failed",
                "reason": "split_too_small",
                "rows": int(len(x)),
            }
            print("  -> Dataset split is too small for reliable evaluation.")
            return False

        x_train, x_test = x[:split_idx], x[split_idx:]
        y_train, y_test = y[:split_idx], y[split_idx:]

        self.model.fit(x_train, y_train)
        self.is_trained = True
        self.player_hero_snapshot = snapshot

        probs = self.model.predict_proba(x_test)[:, 1]
        preds = (probs >= 0.5).astype(int)

        acc = accuracy_score(y_test, preds)
        ll = log_loss(y_test, probs)
        brier = brier_score_loss(y_test, probs)

        try:
            auc = roc_auc_score(y_test, probs)
            auc_text = f"{auc:.4f}"
        except ValueError:
            auc_text = "N/A (single-class test split)"

        print(f"  -> Train rows: {len(x_train)} | Test rows: {len(x_test)}")
        print(f"  -> Accuracy: {acc:.4f}")
        print(f"  -> ROC-AUC:  {auc_text}")
        print(f"  -> LogLoss:  {ll:.4f}")
        print(f"  -> Brier:    {brier:.4f}")
        self.last_train_metrics = {
            "status": "trained",
            "total_rows": int(len(x)),
            "train_rows": int(len(x_train)),
            "test_rows": int(len(x_test)),
            "accuracy": float(acc),
            "roc_auc": None if auc_text.startswith("N/A") else float(auc_text),
            "log_loss": float(ll),
            "brier": float(brier),
        }
        self.save_model_state()
        return True

    def _resolve_hero_names(self, hero_names):
        ids = []
        missing = []
        for name in hero_names:
            hero_id = self.hero_name_to_id.get(name.strip().lower())
            if hero_id is None:
                missing.append(name)
            ids.append(hero_id)
        return ids, missing

    def _resolve_player_names(self, player_names):
        ids = []
        unresolved = []
        for name in player_names:
            player_id = self.player_name_to_id.get(name.strip().lower(), 0)
            if not player_id:
                unresolved.append(name)
            ids.append(player_id)
        return ids, unresolved

    def predict(self, radiant_hero_names, dire_hero_names, radiant_player_names=None, dire_player_names=None):
        if not self.is_trained:
            return {"error": "Model is not trained yet."}

        if len(radiant_hero_names) != 5 or len(dire_hero_names) != 5:
            return {"error": "Each team must provide exactly 5 hero names."}

        radiant_hero_ids, missing_r = self._resolve_hero_names(radiant_hero_names)
        dire_hero_ids, missing_d = self._resolve_hero_names(dire_hero_names)

        if missing_r or missing_d:
            return {"error": f"Unknown hero names: {missing_r + missing_d}"}

        if radiant_player_names is None:
            radiant_player_names = [""] * 5
        if dire_player_names is None:
            dire_player_names = [""] * 5

        if len(radiant_player_names) != 5 or len(dire_player_names) != 5:
            return {"error": "Each team must provide exactly 5 player names (or leave all empty)."}

        radiant_player_ids, unresolved_r = self._resolve_player_names(radiant_player_names)
        dire_player_ids, unresolved_d = self._resolve_player_names(dire_player_names)

        rad_comfort = self._team_comfort(self.player_hero_snapshot, radiant_player_ids, radiant_hero_ids)
        dire_comfort = self._team_comfort(self.player_hero_snapshot, dire_player_ids, dire_hero_ids)

        draft = self._build_draft_vector(radiant_hero_ids, dire_hero_ids)
        extras = np.array([rad_comfort, dire_comfort, rad_comfort - dire_comfort], dtype=np.float32)
        features = np.concatenate((draft, extras), dtype=np.float32).reshape(1, -1)

        radiant_prob = float(self.model.predict_proba(features)[0, 1])
        dire_prob = 1.0 - radiant_prob

        return {
            "radiant_win_prob": round(radiant_prob * 100.0, 2),
            "dire_win_prob": round(dire_prob * 100.0, 2),
            "radiant_comfort": round(rad_comfort * 100.0, 2),
            "dire_comfort": round(dire_comfort * 100.0, 2),
            "unresolved_players": unresolved_r + unresolved_d,
        }


if __name__ == "__main__":
    init_advanced_db()
    app = DotaPredictionV2()

    print("=== DOTA 2 PREDICTION APP (V2) ===")
    update_choice = input("Refresh heroes, pro players, and match cache from OpenDota? (y/n): ").strip().lower()

    if update_choice == "y":
        try:
            app.refresh_reference_data()
            app.fetch_pro_matches(limit=300, max_workers=6)
        except Exception as exc:
            print(f"Data refresh failed: {exc}")

    trained = app.train(min_matches=120)
    if not trained:
        print("Model training skipped. Please fetch more matches and try again.")
        raise SystemExit(0)

    # Example prediction payload
    radiant_team_name = "Nemiga Gaming"
    radiant_player_names = ["byun", "young G", "hotoke", "CoviSnine", "ariel"]
    radiant_hero_names = ["Shadow Fiend", "Ember Spirit", "Tidehunter", "Keeper of the Light", "Clockwerk"]

    dire_team_name = "IC x Insanity"
    dire_player_names = ["Rubikon155", "dualrazee", "Norma", "Fernans", "Kidaro"]
    dire_hero_names = ["Rubick", "Earth Spirit", "Pangolier", "Dark Willow", "Winter Wyvern"]

    result = app.predict(
        radiant_hero_names=radiant_hero_names,
        dire_hero_names=dire_hero_names,
        radiant_player_names=radiant_player_names,
        dire_player_names=dire_player_names,
    )

    print("\n" + "=" * 72)
    print(f" MATCH PREDICTION: {radiant_team_name.upper()} vs {dire_team_name.upper()}")
    print("=" * 72)

    if "error" in result:
        print(f"Error: {result['error']}")
    else:
        print(f"Radiant predicted win rate: {result['radiant_win_prob']:.2f}%")
        print(f"Dire predicted win rate:    {result['dire_win_prob']:.2f}%")
        print("-" * 72)
        print(f"Radiant comfort score:      {result['radiant_comfort']:.2f}%")
        print(f"Dire comfort score:         {result['dire_comfort']:.2f}%")
        unresolved = result.get("unresolved_players") or []
        if unresolved:
            print(f"Note: unresolved player names (fallback baseline used): {unresolved}")

    print("=" * 72 + "\n")