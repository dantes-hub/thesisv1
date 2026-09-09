# Deployment runbook

Target: **Vercel** (frontend) + **Render** (API) + **Qdrant Cloud** (vectors).
All three have free tiers that fit this project; expected cost is **$0/month** plus
per-question OpenAI usage.

There is a chicken-and-egg between the two apps: Vercel needs the API URL at *build*
time, and the API needs the Vercel origin for CORS. The order below resolves it — do
the steps in sequence.

---

## 0. Before you start

You need accounts on Vercel, Render, Qdrant Cloud and OpenAI, and your local Qdrant
running with the ingested collection (`npm run qdrant:up`).

Check what you are about to copy:

```bash
curl -s http://localhost:6333/collections/labor_assistant_v1 | grep -o '"points_count":[0-9]*'
```

---

## 1. Qdrant Cloud

1. Create a **free 1 GB cluster**. Note the cluster URL (`https://….cloud.qdrant.io:6333`)
   and create an API key.
2. Copy the existing vectors up. **Do not re-run the ingestion scripts** — they would
   re-embed all 747 chunks and bill you for it. The vectors already exist locally:

```bash
cd ingestion
source .venv/bin/activate

# Look before you leap
python migrate_to_cloud.py --target-url "https://….cloud.qdrant.io:6333" \
                           --target-api-key "YOUR_KEY" --dry-run

# Then copy for real
python migrate_to_cloud.py --target-url "https://….cloud.qdrant.io:6333" \
                           --target-api-key "YOUR_KEY"
```

It creates the collection with the same vector size and distance, recreates the `type`
payload index that office lookups filter on, copies in batches, and verifies the final
count matches. It refuses to write into a collection that already has points.

---

## 2. Render (API) — first pass

1. Dashboard → **New → Blueprint**, point it at this repo. It reads `render.yaml`.
2. Render prompts for every value marked `sync: false`. Set:

   | Variable | Value |
   |---|---|
   | `OPENAI_API_KEY` | your key |
   | `QDRANT_URL` | the Qdrant Cloud cluster URL |
   | `QDRANT_API_KEY` | the Qdrant Cloud key |
   | `ALLOWED_ORIGINS` | `http://localhost:3000` for now — corrected in step 4 |
   | `ELEVENLABS_API_KEY` etc. | optional; voice answers are disabled without them |

   `CHAT_MODEL` is already set to `gpt-4o-mini` in the blueprint. `gpt-4o` is the model
   the evaluation used and stays the code default; the demo runs mini to cut per-question
   cost roughly 17x.

3. Wait for the deploy, then confirm it is alive and reaching Qdrant:

```bash
curl https://eldertw-api.onrender.com/health
# {"ok":true,"collections":["labor_assistant_v1"]}
```

If `ok` is false, the Qdrant URL or key is wrong. Note the API URL for the next step.

---

## 3. Vercel (frontend)

1. **Add New → Project**, import the repo. Keep the root directory as the repo root —
   `vercel.json` already points the build at the `frontend` workspace.
2. Add one environment variable:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://eldertw-api.onrender.com` (no trailing slash) |

   This is **baked into the client bundle at build time**. Changing it later requires a
   redeploy, not just an env edit.

3. Deploy, and note the resulting URL (e.g. `https://eldertw.vercel.app`).

---

## 4. Render — second pass (close the CORS loop)

Set `ALLOWED_ORIGINS` to the exact Vercel origin — scheme and host, **no trailing
slash, no path**:

```
ALLOWED_ORIGINS=https://eldertw.vercel.app
```

Add preview deployments as a comma-separated list if you want them to work too.
Save; Render redeploys automatically.

Until this is right, the site loads but every question fails — the API answers `403
{"error":"origin_not_allowed"}` and the UI shows a connection error.

---

## 5. Cap the spend (do not skip)

A public URL spends real credits on every question. The per-IP rate limits (10 `/ask`
per minute) slow abuse; they do not cap it. Sustained abuse from one IP is ~14,400
questions/day — about **$7/day on gpt-4o-mini, or ~$122/day on gpt-4o**.

In the OpenAI dashboard → **Billing → Limits**, set a hard monthly usage cap you are
willing to lose (e.g. $5–10). That converts the worst case from a surprise bill into
"the demo stops answering".

Tighten the limits further any time via Render env vars: `RATE_LIMIT_ASK`,
`RATE_LIMIT_TTS`, `RATE_LIMIT_TRANSCRIBE`, `RATE_LIMIT_GLOBAL` (all per minute, per IP).

---

## 6. Verify

```bash
API=https://eldertw-api.onrender.com
WEB=https://eldertw.vercel.app

curl -s $API/health                                   # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' $API/debug/scroll   # 404 — debug off in production

# CORS: your origin allowed, others refused
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS $API/ask \
     -H "Origin: $WEB" -H 'Access-Control-Request-Method: POST'      # 204
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS $API/ask \
     -H 'Origin: https://evil.example.com' -H 'Access-Control-Request-Method: POST'  # 403
```

Then in the browser: open `$WEB`, ask an office question (e.g. 台北辦事處在哪裡), and
confirm you get the office card with address, phone and map link. Check `/en` too, and
toggle high contrast.

---

## Known behaviour on the free tier

**Render free web services sleep after ~15 minutes idle.** The first request then takes
roughly 50 seconds while the container starts. A recruiter clicking a cold link sees a
long "thinking" state. Options:

- Accept it, and say so next to the link ("first load may take ~1 minute").
- Upgrade that one service to Render Starter (~$7/month) to keep it warm.
- Ping `/health` on a schedule to keep it awake — this burns free-tier hours and is
  against the spirit of the tier, so prefer one of the above.

Qdrant Cloud free clusters and Vercel Hobby do not sleep. Vercel Hobby is for
non-commercial personal projects, which this is.

---

## Updating after the first deploy

Both services auto-deploy on push to `main`. Two things do not follow automatically:

- Changing `NEXT_PUBLIC_API_URL` needs a **Vercel redeploy**, since it is compiled in.
- Re-ingesting new source data writes to whichever `QDRANT_URL` is set; point the
  ingestion scripts at the cloud cluster, or re-run `migrate_to_cloud.py` after
  ingesting locally.
