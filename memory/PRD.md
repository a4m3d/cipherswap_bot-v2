# CipherSwap — PRD / Working Notes

## Original task
Imported existing CipherSwap repo (GitHub). Prepare & configure for EXTERNAL production
deployment on Render (FastAPI backend + Telegram bot) + MongoDB Atlas + Vercel (React frontend).
Full security audit (crypto/wallet app). NOT to be deployed on Emergent.

## Architecture (as implemented)
- Backend (`/app/backend`): FastAPI + python-telegram-bot (webhook mode) in one process.
  - `server.py` API + lifespan (bot init, leader election, indexes, webhook).
  - `bot.py` Telegram wizard/flows, pollers, custodial dispatcher.
  - `near_client.py` NEAR Intents 1Click client + token catalog.
  - `evm.py` custodial EVM hot-wallet helper. `nlp.py` NL swap parser. `crypto.py` Fernet key encryption.
- DB: MongoDB (Atlas in prod) via `MONGO_URL`/`DB_NAME`. Collections: users, swaps, custodial, bot_locks, tg_updates.
- Frontend (`/app/frontend`): React (CRA/craco) marketing landing page, uses `REACT_APP_BACKEND_URL`.

## Done (2026-06)
- Synced real project from imported zip into /app (workspace previously held only scaffold).
- Rebuilt server.py: /api/health, CORS fix, required webhook secret (path + header), leader lock
  (single poller/custodial dispatcher), update-id dedup, startup indexes, global error handler.
- near_client.py: call-time env config, timeout/429/4xx/5xx/malformed handling, no secret logging.
- crypto.py + bot.py: custodial private keys encrypted at rest (WALLET_ENCRYPTION_KEY).
- evm.py: pending-nonce fix for multi-chunk dispatch.
- Trimmed requirements.txt (removed Emergent/unused deps); added job-queue extra.
- Frontend rebranded to CipherSwap "any coin, any chain"; removed Emergent dev deps.
- Added render.yaml, runtime.txt, vercel.json, backend/.env.example, frontend/.env.example, DEPLOYMENT.md.
- Verified locally: backend imports/starts, /api/health|stats|bot-info, webhook auth gate,
  encryption roundtrip, frontend production build, no secrets in bundle/repo.

## Residual items requiring human decision (see DEPLOYMENT.md §C)
- Custodial hot-wallet trust model / key management (KMS?).
- Per-chain recipient address validation (currently length-only).
- Rate limiting / abuse controls.

## Not testable without prod creds
- Live Telegram webhook round-trip, real NEAR quote/status, real custodial transfer, Atlas connectivity.
