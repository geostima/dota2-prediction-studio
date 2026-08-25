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
  - dota2-logo.png
- data/
  - live_matches.json: auto-refreshed live/upcoming/recent match snapshot (fetched by app.js from GitHub's raw CDN)
  - citoapi_state.json: usage/rate-limit tracking so the CitoAPI integration stays inside its free quota
  - pandascore_finished_matches.jsonl: append-only archive of finished matches for future model training
- scripts/fetch_live_snapshot.py: one-shot script run by GitHub Actions to refresh data/
- .github/workflows/update-live-data.yml: schedules that script every ~10 minutes
- dota_predictor_advanced.py: model training pipeline
- train_model_once.py: fetch + train workflow
- export_static_bundle.py: exports browser snapshot JSON
- render.yaml: Render static site config

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

## Live Match Data (PandaScore + CitoAPI)

The site is a **single static website with no backend service** (no paid Render
web service required). Live/upcoming/recently-finished matches, team names,
logos, scores, stream links, and best-effort hero picks are sourced from
[PandaScore](https://www.pandascore.co/) and [CitoAPI](https://citoapi.com/)
instead of scraping OpenDota/Cyberscore/DLTV pages.

**How this stays static and keeps API keys safe:** a GitHub Actions workflow
(`.github/workflows/update-live-data.yml`) runs `scripts/fetch_live_snapshot.py`
every ~10 minutes. That script calls PandaScore (and, sparingly, CitoAPI) using
repository secrets, and writes the result to `data/live_matches.json`, which
the Action commits back to the repo. `standalone_site/app.js` then fetches that
file directly from `raw.githubusercontent.com` — a plain static file request,
no server, no API key ever reachable from the browser.

**Setup:** in the GitHub repo, go to Settings → Secrets and variables → Actions,
and add two repository secrets:

- `PANDASCORE_API_TOKEN` — free key from pandascore.co
- `CITOAPI_API_KEY` — free key from citoapi.com (optional; hero picks are
  skipped gracefully if unset)

That's it — no Render service to create, no `proxy_config.json` to edit. The
workflow also runs on `workflow_dispatch`, so you can trigger it manually from
the Actions tab to refresh data immediately instead of waiting for the next
scheduled run.

**Free-plan limitation:** PandaScore's free "Fixtures" plan does not expose
live hero picks (that needs their paid Historical/Real-time plan), and hero
picks only refresh every few hours (see below) due to CitoAPI's tiny free
quota. The live board always shows schedule, team logos, score, and an
elapsed-time clock; hero picks appear when available and otherwise show
"not available yet."

**Refresh cadence tradeoff:** because there's no live server, "live" here means
"refreshed every ~10 minutes by a scheduled job" (GitHub's cron scheduler can
also add its own few-minutes delay), not truly real-time. This is the
deliberate cost of keeping the whole project free and backend-free.

### Rate-limit budget

- **PandaScore:** the workflow makes ~3 calls (running/upcoming/past) every 10
  minutes → ~18/hour, far under the free 1000 requests/hour cap, regardless of
  how many people visit the site (visitors only ever read the static JSON file).
- **CitoAPI:** hero picks are attempted at most once every 4 hours, for at most
  2 live matches per attempt (~2 calls), tracked in `data/citoapi_state.json`
  with a hard monthly cap (400, under the free 500/month limit) so the job
  never gets throttled or loses its key.

### Building a team-stats dataset from PandaScore

Every run appends newly-finished matches (team names, scores, winner) to
`data/pandascore_finished_matches.jsonl`, deduplicated by match id. This is a
starting point for training a future model on PandaScore-sourced team
statistics instead of OpenDota.


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
