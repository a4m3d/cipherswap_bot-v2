# CipherSwap — External Deployment Guide (Render + MongoDB Atlas + Vercel)

This project is prepared for **external** production hosting. It does **not** depend on
Emergent infrastructure or an Emergent-managed database.

```
GitHub
  ├── Render  → FastAPI backend + Telegram bot (single web service)
  ├── MongoDB Atlas → production database
  └── Vercel  → React frontend
```

---

## A. What changed in the code

**Backend**
- `server.py` fully rebuilt for production:
  - Added `GET /api/health` health endpoint (used by Render).
  - `load_dotenv` now runs **before** importing app modules (fixes env being read too early).
  - CORS: reads `CORS_ORIGINS` (comma-separated). `allow_credentials` is disabled automatically when origin is `*` (browsers reject `*` + credentials).
  - Telegram webhook hardened: `TELEGRAM_WEBHOOK_SECRET` is **required** (no insecure `hook` default), verified in **both** the URL path and the `X-Telegram-Bot-Api-Secret-Token` header using constant-time comparison.
  - Webhook registered with `secret_token=` and `drop_pending_updates=False` (no longer drops updates on every restart).
  - **Multi-instance safety** (you chose this): a Mongo leader lock (`bot_locks`) guarantees the status poller and the custodial fund-dispatcher run on exactly one instance; every Telegram update is de-duplicated by `update_id` (`tg_updates`, TTL 1h) so retries/scaling can never double-process.
  - MongoDB indexes created on startup (idempotent): `swaps.sid` (unique), `swaps(chat_id, created_at)`, `swaps.status`, `swaps.deposit_address`, `swaps.gid`, `custodial.dispatched`, `custodial.chat_id`, `tg_updates.ts` (TTL).
  - Global exception handler returns a generic `{"detail":"internal server error"}` — no stack traces/internals leaked.
  - `PUBLIC_BASE_URL` trailing slash normalized.
- `near_client.py`: config (`NEAR_INTENTS_BASE`, `NEAR_INTENTS_JWT`) read at call time; timeouts, network errors, HTTP 429/4xx/5xx and malformed JSON handled and converted to safe user messages; upstream error bodies logged server-side only, never returned to users; JWT never logged.
- `crypto.py` (new): custodial hot-wallet private keys are encrypted at rest with Fernet using `WALLET_ENCRYPTION_KEY`.
- `bot.py`: custodial wallet private key is stored **encrypted** (`pk_enc`) instead of plaintext; decrypted only in-memory at dispatch time; feature auto-disables (with a friendly message) if `WALLET_ENCRYPTION_KEY` is missing. User still receives their own plaintext recovery key in Telegram.
- `evm.py`: ERC-20 transfer now uses the `pending` nonce to avoid nonce collisions when dispatching multiple split chunks quickly.
- `requirements.txt`: trimmed to only what the app imports; removed unused/Emergent-specific packages (`emergentintegrations`, Emergent-hosted `litellm` wheel, boto3, stripe, google, pandas, numpy, openai, etc.). Added `[job-queue]` extra needed by the bot.

**Frontend**
- Rebranded landing copy to CipherSwap "any coin, any chain" (removed stale Base→Starknet / `/bridge` / "RelayBridge" wording).
- Removed Emergent-hosted dev dependencies (`@emergentbase/overlay`, `@emergentbase/visual-edits`) so Vercel installs never depend on Emergent asset hosting (craco already fails open without them).
- Continues to use `REACT_APP_BACKEND_URL` for the API base (no hardcoded backend URL).

**Config added**
- `render.yaml`, `backend/runtime.txt`, `frontend/vercel.json`, `backend/.env.example`, `frontend/.env.example`.

---

## B. Security issues found and fixed
1. **Plaintext private keys in DB** (custodial "Pay-once split"): now encrypted at rest via `WALLET_ENCRYPTION_KEY` (Fernet).
2. **Weak/guessable webhook secret** (`hook` default) and no request authentication: now a required secret validated in path + Telegram header with constant-time compare.
3. **CORS `*` + credentials** (invalid/permissive): credentials disabled for wildcard; production locks to your Vercel origin via `CORS_ORIGINS`.
4. **Unbounded upstream error text** potentially returned to users: now logged server-side, generic message to users.
5. **Nonce collisions** in multi-chunk custodial dispatch: use `pending` nonce.
6. **Duplicate transaction risk under scaling / webhook retries**: leader lock (single dispatcher) + update-id de-duplication (at-most-once processing). The custodial job is marked `dispatched=True` before sending, giving at-most-once dispatch (a crash mid-batch leaves remaining funds recoverable via the user's recovery key — never a double-send).
7. **Env read before dotenv load**: fixed import ordering + call-time config reads.

---

## C. Security issues that still require YOUR attention
1. **Custodial model is inherently trust-bearing.** During a "Pay-once split", the backend briefly holds user funds in a server-generated hot wallet and the private key exists (encrypted) in your DB and (plaintext) in the user's Telegram chat as a recovery key. Encryption protects a DB dump, **but** anyone with both the DB and `WALLET_ENCRYPTION_KEY` (e.g. full server compromise) can move in-flight custodial funds. Decide whether to keep this feature in production. Store `WALLET_ENCRYPTION_KEY` only in Render (never in Git), and consider a dedicated secret manager / KMS for higher assurance.
2. **Recipient/refund address validation is minimal** (`bot.py._valid_addr`: length + no-spaces only). It does **not** verify the address matches the destination chain's format. A user pasting a wrong-chain or malformed address could send funds to an unintended destination. Recommend adding per-chain address validation before go-live. (Not changed automatically — it's a product decision and a larger change.)
3. **No per-user rate limiting / abuse controls** on the bot or the public `/api/stats`. Consider basic limits before a public launch.
4. **Delayed split reminders** use an in-memory job queue; they are lost on restart/redeploy (no funds are moved by these jobs — they only send deposit cards). Acceptable, but note it.
5. **Amount precision**: split math quantizes to 2 decimals; fine for USDC/USDT-style tokens but review if you enable tokens with very different precision.

---

## D. Render configuration
| Setting | Value |
|---|---|
| Root Directory | `backend` |
| Runtime | Python (`runtime.txt` pins `python-3.11.9`) |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn server:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/api/health` |
| Instances | **1** (do not autoscale — see note below) |

The app binds `0.0.0.0` and uses Render's `$PORT`. `render.yaml` is included for one-click Blueprint deploys.

> Scaling note: the bot keeps conversation (wizard) state in memory per process. The leader lock + update de-dup make it **financially safe** under multiple instances, but the multi-step wizard UX only works correctly on a single instance. Keep `numInstances: 1`.

---

## E. Render environment variables
| Variable | Secret? | Backend-only? | Where to get it |
|---|---|---|---|
| `MONGO_URL` | **Yes** | Yes | MongoDB Atlas → Cluster → Connect → Drivers (SRV string incl. user/password) |
| `DB_NAME` | No | Yes | You choose, e.g. `cipherswap` |
| `CORS_ORIGINS` | No | Yes | Your final Vercel URL, e.g. `https://cipherswap.vercel.app` |
| `TELEGRAM_TOKEN` | **Yes** | Yes | Telegram @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | **Yes** | Yes | Generate: `python -c "import secrets;print(secrets.token_urlsafe(32))"` |
| `PUBLIC_BASE_URL` | No | Yes | Your Render backend URL, e.g. `https://cipherswap-backend.onrender.com` (set after first deploy) |
| `NEAR_INTENTS_BASE` | No | Yes | `https://1click.chaindefuser.com` (default; you have no JWT / 1Click) |
| `NEAR_INTENTS_JWT` | **Yes** (if used) | Yes | Leave empty — 1Click works without auth for you |
| `WALLET_ENCRYPTION_KEY` | **Yes** | Yes | Generate: `python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"` |
| `PYTHON_VERSION` | No | Yes | `3.11.9` (optional; `runtime.txt` already pins it) |

Do **not** put any of these in Git. `.env.example` lists names/placeholders only.

---

## F. Vercel environment variables
| Variable | Secret? | Notes |
|---|---|---|
| `REACT_APP_BACKEND_URL` | No (public — baked into bundle) | Your Render backend URL, e.g. `https://cipherswap-backend.onrender.com` |

Never add `MONGO_URL`, `TELEGRAM_TOKEN`, `NEAR_INTENTS_JWT`, `WALLET_ENCRYPTION_KEY` or any private key to Vercel — anything `REACT_APP_*` ships to the browser.

Vercel project settings: Root Directory `frontend`, Framework `Create React App`, Build `yarn build`, Install `yarn install`, Output `build` (all captured in `frontend/vercel.json`).

---

## G. MongoDB Atlas setup
1. Create a project + cluster (M0 free tier is fine to start).
2. Database Access → add a user with a strong password (readWrite on the app DB).
3. Network Access → allow Render egress. Simplest: allow `0.0.0.0/0` (rely on user/password + TLS), or restrict to Render's static outbound IPs if you enable them.
4. Connect → Drivers → copy the `mongodb+srv://...` string → this is `MONGO_URL`. Set `DB_NAME` (e.g. `cipherswap`).
5. **No manual index creation needed** — the backend creates all indexes idempotently on startup. (If you prefer, you can pre-create them, but it's not required.)

---

## H. Telegram webhook setup
- The bot runs in **webhook** mode (no polling). The backend registers the webhook automatically on startup once `PUBLIC_BASE_URL` and `TELEGRAM_WEBHOOK_SECRET` are set.
- Webhook URL: `${PUBLIC_BASE_URL}/api/telegram/webhook/${TELEGRAM_WEBHOOK_SECRET}` with the same secret sent as `X-Telegram-Bot-Api-Secret-Token`.
- You do **not** need to call `setWebhook` manually. To verify after deploy:
  `curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/getWebhookInfo"`
- If you ever need to reset: `curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/deleteWebhook"` then redeploy.

---

## I. Deployment order
1. **MongoDB Atlas** — create cluster/user, get `MONGO_URL`, choose `DB_NAME`.
2. **Render backend** — deploy with env vars from section E (you can set `PUBLIC_BASE_URL` after the URL is known; a redeploy/restart will register the webhook). Set `CORS_ORIGINS` to a placeholder or `*` temporarily.
3. **Set `PUBLIC_BASE_URL`** to the Render URL and restart — webhook auto-registers.
4. **Confirm Telegram webhook** via `getWebhookInfo`.
5. **Vercel frontend** — set `REACT_APP_BACKEND_URL` to the Render URL, deploy.
6. **Set `CORS_ORIGINS`** on Render to the final Vercel domain and restart.
7. **Final testing** — see section below.

---

## J. Exact commands / settings
**Generate secrets (local):**
```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"                       # TELEGRAM_WEBHOOK_SECRET
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"  # WALLET_ENCRYPTION_KEY
```
**Render (Web Service):** Root `backend` · Build `pip install -r requirements.txt` · Start `uvicorn server:app --host 0.0.0.0 --port $PORT` · Health `/api/health` · Instances `1`.

**Vercel:** Root `frontend` · Framework CRA · Build `yarn build` · Output `build`.

**Verify after deploy:**
```bash
curl https://<render-app>.onrender.com/api/health          # {"status":"ok"}
curl https://<render-app>.onrender.com/api/bot-info         # bot username/link
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"  # url + pending_update_count
```

---

## K. Architecture changes required before deploy
- **None are blocking.** The single-service (API + webhook bot + in-process pollers) design works on Render as-is with `numInstances: 1`.
- **Recommended before a real public launch** (product decisions, not done automatically): per-chain recipient address validation (C.2), a decision on keeping the custodial feature (C.1), and basic rate limiting (C.3).

---

## What could NOT be tested here (needs your production credentials)
- Live Telegram webhook round-trip and `set_webhook` (needs a real `TELEGRAM_TOKEN` + public HTTPS URL). Verified locally: webhook auth gate (403/503), update de-dup, and startup wiring.
- Real NEAR Intents `/v0/quote` and `/v0/status` calls (needs network/production context). Verified locally: config is env-driven and error paths are safe.
- Real custodial on-chain transfer (needs funded wallet). Verified locally: private-key encryption/decryption roundtrip and that plaintext never persists.
- MongoDB Atlas connectivity (tested against the local Mongo; connection is env-driven).
