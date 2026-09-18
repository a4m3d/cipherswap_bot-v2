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
- crypto.py + bot.py: custodial private keys encrypted at rest (WALLET_ENCRYPTION_KEY); Pay-once Split RETAINED.
- addr_validate.py: chain-specific recipient/refund validation (eth-utils/base58/bech32) wired into bot.py.
- Custodial dispatch hardened: atomic {dispatched:false}->true claim (no double payout), sid entropy 8 bytes.
- evm.py: pending-nonce fix for multi-chunk dispatch.
- Trimmed requirements.txt (removed Emergent/unused deps); added job-queue, base58, bech32.
- Frontend rebranded to CipherSwap "any coin, any chain"; removed Emergent dev deps.
- Added render.yaml, runtime.txt, vercel.json, backend/.env.example, frontend/.env.example, DEPLOYMENT.md.
- Verified locally: imports/start, /api/health|stats|bot-info, webhook auth gate, encryption roundtrip,
  address validators (real valid accepted / invalid rejected), CORS allow+block, frontend build, no secrets
  in bundle/repo/git-history.
- Rate limiting intentionally NOT added (per user instruction).

## Residual items requiring human decision (see DEPLOYMENT.md §C)
- Custodial hot-wallet trust model: encryption ≠ protection against full server compromise; future KMS/HSM.
- Delayed split reminders are in-memory (lost on restart; no funds moved).
- Amount precision quantized to 2 decimals.

## Not testable without prod creds
- Live Telegram webhook round-trip, real NEAR quote/status, real custodial transfer, Atlas connectivity.
