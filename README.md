# Dota 2 Prediction Studio

A static, browser-based Dota 2 draft prediction site.

Predictions run fully in the browser using a pre-exported model snapshot file:
- standalone_site/model_bundle.json

## Project Structure

- standalone_site/
  - index.html
  - styles.css
  - app.js
  - model_bundle.json
  - proxy_config.json: points the live board at the deployed live_feed_proxy.py URL
  - dota2-logo.png
- dota_predictor_advanced.py: model training pipeline
- train_model_once.py: fetch + train workflow
- export_static_bundle.py: exports browser snapshot JSON
- live_feed_proxy.py: Flask proxy holding the PandaScore token, serving live match data
- render.yaml: Render config for the static site + live proxy service

## Local Setup (for training/export only)

Install dependencies:

C:/Users/Administrator/AppData/Local/Python/pythoncore-3.14-64/python.exe -m pip install -r requirements.txt

## Usage

### 1. Run the website locally (optional)

You can open standalone_site/index.html directly in a browser.

If your browser blocks local JSON fetch for model_bundle.json, use a lightweight local server in the project folder:

C:/Users/Administrator/AppData/Local/Python/pythoncore-3.14-64/python.exe -m http.server 8080

Then open:
http://127.0.0.1:8080/standalone_site/

### 2. Use the app

1. Enter Radiant and Dire team names.
2. Enter 5 players and 5 heroes per side.
3. Click Generate Prediction.
4. Optionally click Load Sample Data to preload an example match.

## Deploy to Render (Static Site)

1. Push this repository to GitHub.
2. In Render, create a new Static Site from this GitHub repo.
3. Set Publish Directory to standalone_site.
4. Build command can be empty.
5. Deploy.

If using render.yaml blueprint, Render auto-detects static publish path.

## Live Match Data (PandaScore)

Live/upcoming/recently-finished matches, team names, logos, scores, and stream
links are sourced from [PandaScore](https://www.pandascore.co/)'s Dota 2
fixtures API instead of scraping OpenDota/Cyberscore/DLTV pages.

**Why a proxy is required:** the standalone site is a static page with no
backend. PandaScore API tokens must never be shipped to the browser (anyone
could read it from page source and burn your rate limit or get the key
revoked), so `live_feed_proxy.py` is a small Flask service that holds the
token server-side, polls PandaScore on a cache schedule, and serves normalized
JSON to `standalone_site/app.js`. Only the proxy talks to PandaScore — browser
traffic never counts against your PandaScore rate limit.

**Free-plan limitation:** PandaScore's free "Fixtures" plan does not expose
live hero picks, player lineups, or in-game stats (that requires their paid
Historical/Real-time plan). The live board shows schedule, team logos, score,
and an elapsed-time clock. Hero picks for live matches are instead fetched
on-demand from CitoAPI (see below) when you expand a match's details.

### 1. Run the proxy locally

Set your PandaScore API token as an environment variable (get one free at
pandascore.co) and start the Flask app:

```powershell
$env:PANDASCORE_API_TOKEN = "your-token-here"
C:/Users/Administrator/AppData/Local/Python/pythoncore-3.14-64/python.exe live_feed_proxy.py
```

This serves `http://127.0.0.1:5050`, which `standalone_site/proxy_config.json`
already points to by default for local development. Never commit your real
token to a file in this repo.

### 2. Deploy the proxy

`render.yaml` defines a second Render web service (`d2p-live-proxy`) running
`live_feed_proxy.py` via gunicorn with a single worker (required so the
in-memory PandaScore cache isn't duplicated across processes). After deploying:

1. In the Render dashboard, open the `d2p-live-proxy` service's Environment tab
   and set `PANDASCORE_API_TOKEN` (and `CITOAPI_API_KEY`, see below) to your keys.
2. Copy the service's public URL (e.g. `https://d2p-live-proxy.onrender.com`).
3. Edit `standalone_site/proxy_config.json` and set `proxy_base_url` to that URL.
4. Commit and push; Render redeploys the static site with the new proxy URL.

### Rate-limit budget

The proxy caches PandaScore responses (running matches: 20s, upcoming: 120s,
past: 300s) regardless of how many visitors hit the site, so PandaScore usage
stays well under the free 1000 requests/hour cap even under heavy site traffic.

## Hero Picks (CitoAPI)

Live hero picks/bans and player-hero pairings for the currently-playing map
come from [CitoAPI](https://citoapi.com/)'s Dota 2 endpoints, which aggregate
match data (including OpenDota's live draft feed) into a cleaner schema.

CitoAPI's free tier is capped at **500 calls/month and 10 calls/minute**, far
too small to poll continuously, so this integration is strictly **on-demand**:
`live_feed_proxy.py` only calls CitoAPI when a user clicks "Show Details" or
"Use This Match" on a *live* match card — never as part of the auto-refresh
polling loop. Server-side guardrails:

- A SQLite-backed monthly usage counter (`citoapi_usage` table) stops calling
  CitoAPI once `CITOAPI_MONTHLY_CAP` (default 450, leaving headroom under 500)
  is reached for the current month.
- A minimum 7-second interval between CitoAPI calls keeps well under 10/minute.
- Per-match results are cached in memory until the draft is complete (10 heroes
  known) or for 60 seconds otherwise, so repeated clicks don't burn quota.

Set `CITOAPI_API_KEY` (from citoapi.com's dashboard) alongside
`PANDASCORE_API_TOKEN` for both local dev and the deployed proxy service. If
it's unset, hero picks simply show "not available" and the rest of the site
works normally.

### Building a team-stats dataset from PandaScore

Every time the proxy refreshes finished matches, it upserts them into a local
SQLite database (`pandascore_data.db`, git-ignored) with team names, scores,
and winners via `/api/finished_matches`. This is a starting point for training
a future model on PandaScore-sourced team statistics instead of OpenDota.


## How to Update Snapshot Later

When you want fresh predictions, run these two commands locally in this order:

1) Refresh data and train:

C:/Users/Administrator/AppData/Local/Python/pythoncore-3.14-64/python.exe train_model_once.py

2) Export new browser snapshot:

C:/Users/Administrator/AppData/Local/Python/pythoncore-3.14-64/python.exe export_static_bundle.py

This rewrites:
- standalone_site/model_bundle.json

Then publish it:

1. Commit and push changes to GitHub.
2. Render auto-deploys (or click Deploy latest commit in Render).

## Team Logos

Team logos are served from the repo instead of hotlinked feeds (most feed logo URLs are dead).
Only active tier 1-3 teams are stored; anything else shows a placeholder crest.

Refresh them with:

python download_team_logos.py --prune

Tuning flags: --min-rating (default 1000), --active-days (default 400), --limit (default 250).
Teams present in the exported model bundle rosters are always included. Images are downscaled to
128px when Pillow is installed.

This downloads images into standalone_site/assets/teams/ and rewrites standalone_site/team_logo_overrides.json
(team name -> relative image path).

To add a logo by hand: drop the image into standalone_site/assets/teams/ and add an entry to
team_logo_overrides.json, for example "PARIVISION": "assets/teams/parivision.png". The key must match the
team name shown on the live board. Manual entries are preserved by the script as long as the file exists.

Resolution order at runtime is:
repo override -> OpenDota team index (cached in localStorage for 24h) -> feed URL -> assets/teams/_placeholder.svg.

## Recommended Update Checklist

1. Run train_model_once.py
2. Run export_static_bundle.py
3. Verify timestamp on the homepage
4. Commit and push
5. Confirm Render deploy succeeded

## Notes

- The public website is static and does not retrain on its own.
- Model quality depends on the latest exported snapshot.
- If player names are unresolved, the app falls back to baseline comfort values.
