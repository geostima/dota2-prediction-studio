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

## Secondary Live Data Source (Free Mode)

The static site now uses a fully free client-side provider chain:
1. OpenDota live API
2. Cyberscore page mirror via r.jina.ai
3. DLTV matches page mirror via r.jina.ai (used to surface additional tournament matches such as EPL)

No extra paid Render web service is required for this mode.

Live match source badges:
- OpenDota: match came from OpenDota feed only.
- Cyberscore: match came from Cyberscore mirror extraction only.
- Cyberscore + OpenDota: same match was detected in both feeds and merged.
- DLTV: match came from DLTV mirror extraction only.
- DLTV + OpenDota: same match was detected in both feeds and merged.

Optional: if you want server-side control later, live_feed_proxy.py can still be deployed separately, but it is not required for free operation.

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
(team name -> relative image path). To fix a single team manually, drop a PNG into standalone_site/assets/teams/
and add an entry to team_logo_overrides.json. Resolution order at runtime is:
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
