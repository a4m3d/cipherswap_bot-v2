"""CipherSwap backend: FastAPI API + Telegram bot (webhook mode).

Designed to run on a single always-on Render web service, but hardened to be
safe if Render ever runs more than one instance:
  * A Mongo-based leader lock guarantees the background pollers and the custodial
    dispatcher (the only components that move funds) run on exactly ONE instance,
    so no transaction is ever dispatched twice.
  * Every Telegram update is de-duplicated by update_id before processing, so a
    Telegram retry (or two instances both receiving a webhook) cannot double-process.
For correct conversation (wizard) UX, run a single instance — python-telegram-bot
keeps conversation state in memory per process.
"""
import os
import uuid
import asyncio
import logging
from pathlib import Path
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from hmac import compare_digest

from dotenv import load_dotenv

# Load .env BEFORE importing modules that read configuration.
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

from fastapi import FastAPI, APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from pydantic import BaseModel
from decimal import Decimal
import secrets

from telegram import Update, BotCommand

from near_client import NearBridgeClient, TERMINAL_STATUSES, net_name
from addr_validate import validate_address
import bot as botmod

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
# httpx logs full request URLs which can include the bot token / auth params.
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url, serverSelectionTimeoutMS=8000, tz_aware=True)
db = client[os.environ['DB_NAME']]

TELEGRAM_TOKEN = os.environ.get('TELEGRAM_TOKEN')
WEBHOOK_SECRET = os.environ.get('TELEGRAM_WEBHOOK_SECRET')
PUBLIC_BASE_URL = (os.environ.get('PUBLIC_BASE_URL') or '').rstrip('/')

INSTANCE_ID = uuid.uuid4().hex
LEADER_TTL = 30          # seconds a leadership claim stays valid
LEADER_REFRESH = 10      # seconds between leadership refreshes
DEDUP_TTL = 3600         # seconds to remember processed update ids

near = NearBridgeClient()
state = {"application": None, "bot_info": {}, "leading": False}


async def _ensure_indexes():
    try:
        await db.swaps.create_index("sid", unique=True)
        await db.swaps.create_index([("chat_id", 1), ("created_at", -1)])
        await db.swaps.create_index("status")
        await db.swaps.create_index("deposit_address")
        await db.swaps.create_index("gid")
        await db.custodial.create_index("dispatched")
        await db.custodial.create_index("chat_id")
        await db.tg_updates.create_index("ts", expireAfterSeconds=DEDUP_TTL)
        await db.web_swaps.create_index("sid", unique=True)
        await db.web_swaps.create_index("gid")
        await db.web_swaps.create_index("status")
    except Exception:
        logger.exception("index creation issue (continuing)")


async def _try_acquire_leadership() -> bool:
    now = datetime.now(timezone.utc)
    expiry = now + timedelta(seconds=LEADER_TTL)
    doc = await db.bot_locks.find_one_and_update(
        {"_id": "bot_leader", "$or": [{"expires_at": {"$lt": now}}, {"owner": INSTANCE_ID}]},
        {"$set": {"owner": INSTANCE_ID, "expires_at": expiry}},
        return_document=ReturnDocument.AFTER,
    )
    if doc:
        return True
    try:
        await db.bot_locks.insert_one({"_id": "bot_leader", "owner": INSTANCE_ID, "expires_at": expiry})
        return True
    except DuplicateKeyError:
        return False


async def _on_become_leader(application):
    logger.info("This instance (%s) is now the bot leader", INSTANCE_ID)
    try:
        await application.bot.set_my_commands([
            BotCommand("start", "Choose a mode or type a swap"),
            BotCommand("swap", "Universal swap (any coin / chain)"),
            BotCommand("addresses", "Your saved address book"),
            BotCommand("history", "Recent swaps"),
            BotCommand("privacy", "Privacy toolkit"),
            BotCommand("clear", "Wipe all your data"),
        ])
    except Exception:
        logger.exception("set_my_commands failed")
    if PUBLIC_BASE_URL and WEBHOOK_SECRET:
        try:
            url = f"{PUBLIC_BASE_URL}/api/telegram/webhook/{WEBHOOK_SECRET}"
            await application.bot.set_webhook(
                url=url, secret_token=WEBHOOK_SECRET,
                allowed_updates=Update.ALL_TYPES, drop_pending_updates=False,
            )
            logger.info("Telegram webhook registered (leader).")
        except Exception:
            logger.exception("Failed to set Telegram webhook")
    elif PUBLIC_BASE_URL and not WEBHOOK_SECRET:
        logger.warning("PUBLIC_BASE_URL set but TELEGRAM_WEBHOOK_SECRET missing — webhook NOT registered.")
    else:
        logger.warning("PUBLIC_BASE_URL not set — webhook NOT registered (bot will not receive updates).")
    botmod.start_pollers(application)


async def _leadership_loop(application):
    while True:
        try:
            leading = await _try_acquire_leadership()
            if leading and not state["leading"]:
                state["leading"] = True
                await _on_become_leader(application)
            elif not leading and state["leading"]:
                state["leading"] = False
                logger.warning("Lost bot leadership — stopping pollers on this instance.")
                await botmod.stop_pollers()
        except Exception:
            logger.exception("leadership loop error")
        await asyncio.sleep(LEADER_REFRESH)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _ensure_indexes()
    leadership_task = None
    if TELEGRAM_TOKEN:
        try:
            try:
                await near.catalog.load()
                logger.info("Token catalog loaded: %d assets", len(near.catalog._tokens))
            except Exception:
                logger.exception("catalog load failed (will retry lazily)")
            application = botmod.create_application(TELEGRAM_TOKEN, db, near)
            await application.initialize()
            await application.start()
            me = await application.bot.get_me()
            state["application"] = application
            state["bot_info"] = {"username": me.username, "name": me.first_name}
            logger.info("Bot @%s initialized on instance %s", me.username, INSTANCE_ID)
            leadership_task = asyncio.create_task(_leadership_loop(application))
        except Exception:
            logger.exception("Failed to start Telegram bot")
    else:
        logger.warning("TELEGRAM_TOKEN not set — running API only, bot disabled.")
    yield
    if leadership_task:
        leadership_task.cancel()
    app_ = state.get("application")
    if app_:
        try:
            await botmod.stop_pollers()
            await app_.stop()
            await app_.shutdown()
        except Exception:
            logger.exception("Error during bot shutdown")
    client.close()


app = FastAPI(lifespan=lifespan)
api_router = APIRouter(prefix="/api")


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    # Never leak stack traces / internals to clients.
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})


@api_router.get("/")
async def root():
    return {"message": "CipherSwap API is running"}


@api_router.get("/health")
async def health():
    return {"status": "ok"}


@api_router.get("/bot-info")
async def bot_info():
    info = state.get("bot_info", {})
    username = info.get("username")
    return {
        "username": username,
        "name": info.get("name"),
        "link": f"https://t.me/{username}" if username else None,
    }


@api_router.get("/stats")
async def stats():
    total = await db.swaps.count_documents({})
    completed = await db.swaps.count_documents({"status": "SUCCESS"})
    return {"total_swaps": total, "completed": completed}


@api_router.post("/telegram/webhook/{secret}")
async def telegram_webhook(secret: str, request: Request):
    if not WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="webhook not configured")
    header_secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
    if not compare_digest(secret, WEBHOOK_SECRET) or not compare_digest(header_secret, WEBHOOK_SECRET):
        raise HTTPException(status_code=403, detail="forbidden")
    application = state.get("application")
    if not application:
        raise HTTPException(status_code=503, detail="bot not ready")
    data = await request.json()
    update = Update.de_json(data, application.bot)
    if update is None:
        return {"ok": True}
    # Idempotency: process each Telegram update exactly once (safe under retries/scaling).
    try:
        await db.tg_updates.insert_one({"_id": update.update_id, "ts": datetime.now(timezone.utc)})
    except DuplicateKeyError:
        return {"ok": True}
    await application.process_update(update)
    return {"ok": True}


# ---------------- Web swap API (anonymous, standalone, non-custodial) ----------------
class WebQuoteRequest(BaseModel):
    origin_net: str
    src_sym: str
    dest_net: str
    dst_sym: str
    amount: str
    recipient: str
    refund: str
    split: int = 1
    zero_trace: bool = False


def _parse_iso(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


async def _load_catalog():
    try:
        await near.catalog.load()
    except Exception:
        raise HTTPException(status_code=502, detail="token catalog unavailable")


@api_router.get("/web/networks")
async def web_networks():
    await _load_catalog()
    return {"networks": [{"code": n, "name": net_name(n)} for n in near.catalog.networks()]}


@api_router.get("/web/coins")
async def web_coins(network: str):
    await _load_catalog()
    coins = near.catalog.coins_on(network)
    return {"coins": [
        {"symbol": t.get("symbol"), "assetId": t.get("assetId"), "decimals": t.get("decimals"),
         "contractAddress": t.get("contractAddress"), "price": t.get("price")}
        for t in coins
    ]}


@api_router.get("/web/resolve-ca")
async def web_resolve_ca(network: str, address: str):
    await _load_catalog()
    t = near.catalog.find_by_ca(network, address)
    if not t:
        raise HTTPException(status_code=404, detail="No swappable token found for that contract address on this network")
    return {"symbol": t.get("symbol"), "assetId": t.get("assetId"),
            "decimals": t.get("decimals"), "contractAddress": t.get("contractAddress"),
            "price": t.get("price"), "network": network}


@api_router.post("/web/quote")
async def web_quote(req: WebQuoteRequest):
    await _load_catalog()
    origin_net = (req.origin_net or "").lower()
    dest_net = (req.dest_net or "").lower()
    src = near.catalog.find(req.src_sym, origin_net)
    dst = near.catalog.find(req.dst_sym, dest_net)
    if not src or not dst:
        raise HTTPException(status_code=400, detail="unknown coin/network pair")
    recipient = (req.recipient or "").strip()
    refund = (req.refund or "").strip()
    # Chain-specific validation BEFORE any deposit is created. Never altered.
    if not validate_address(recipient, dest_net):
        raise HTTPException(status_code=400, detail=f"recipient is not a valid {net_name(dest_net)} address")
    if not validate_address(refund, origin_net):
        raise HTTPException(status_code=400, detail=f"refund is not a valid {net_name(origin_net)} address")
    try:
        amount = Decimal(str(req.amount).strip())
    except Exception:
        raise HTTPException(status_code=400, detail="invalid amount")
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be greater than 0")
    n = max(1, min(int(req.split or 1), 4))
    gid = secrets.token_hex(6)
    chunks = botmod._split_amount(amount, n) if n > 1 else [amount]
    deposits = []
    for c in chunks:
        try:
            q = await near.quote(src["assetId"], dst["assetId"], c, src["decimals"], recipient, refund)
        except Exception as e:
            logger.exception("web quote failed")
            raise HTTPException(status_code=502, detail=str(e)[:160])
        sid = secrets.token_hex(8)
        await db.web_swaps.insert_one({
            "sid": sid, "gid": gid, "deposit_address": q["deposit_address"],
            "deposit_memo": q.get("deposit_memo"), "recipient": recipient, "refund": refund,
            "amount_in": str(c), "amount_out": q.get("amount_out_formatted"),
            "amount_out_usd": q.get("amount_out_usd"),
            "src_sym": src["symbol"], "src_net": origin_net,
            "dst_sym": dst["symbol"], "dst_net": dest_net,
            "deadline": q.get("deadline"), "status": "PENDING_DEPOSIT",
            "ephemeral": bool(req.zero_trace), "source": "web",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        deposits.append({
            "sid": sid, "deposit_address": q["deposit_address"],
            "deposit_memo": q.get("deposit_memo"), "amount_in": str(c),
            "amount_out_formatted": q.get("amount_out_formatted"),
            "amount_out_usd": q.get("amount_out_usd"),
            "time_estimate": q.get("time_estimate"), "deadline": q.get("deadline"),
        })
    return {"gid": gid, "count": len(deposits), "deposits": deposits,
            "src_sym": src["symbol"], "src_net": origin_net,
            "dst_sym": dst["symbol"], "dst_net": dest_net, "recipient": recipient}


@api_router.get("/web/swap/{sid}")
async def web_swap_status(sid: str):
    doc = await db.web_swaps.find_one({"sid": sid})
    if not doc:
        raise HTTPException(status_code=404, detail="swap not found")
    status = doc.get("status", "PENDING_DEPOSIT")
    now = datetime.now(timezone.utc)
    checked = _parse_iso(doc.get("status_checked_at"))
    fresh = bool(checked and (now - checked).total_seconds() < 5)
    if status not in TERMINAL_STATUSES and not fresh:
        try:
            res = await near.get_status(doc["deposit_address"], doc.get("deposit_memo"))
        except Exception:
            res = None
        if res:
            status = res.get("status", status)
            upd = {"status": status, "status_checked_at": now.isoformat()}
            for k in ("amount_out_formatted", "amount_out_usd", "origin_tx_url", "dest_tx_url", "refund_reason"):
                if res.get(k):
                    key = "amount_out" if k == "amount_out_formatted" else k
                    upd[key] = res.get(k)
            await db.web_swaps.update_one({"_id": doc["_id"]}, {"$set": upd})
            doc.update(upd)
    payload = {
        "sid": sid, "status": status,
        "amount_in": doc.get("amount_in"), "amount_out": doc.get("amount_out"),
        "amount_out_usd": doc.get("amount_out_usd"),
        "src_sym": doc.get("src_sym"), "src_net": doc.get("src_net"),
        "dst_sym": doc.get("dst_sym"), "dst_net": doc.get("dst_net"),
        "recipient": doc.get("recipient"), "deposit_address": doc.get("deposit_address"),
        "deposit_memo": doc.get("deposit_memo"), "deadline": doc.get("deadline"),
        "origin_tx_url": doc.get("origin_tx_url"), "dest_tx_url": doc.get("dest_tx_url"),
        "refund_reason": doc.get("refund_reason"),
    }
    if doc.get("ephemeral") and status in TERMINAL_STATUSES:
        await db.web_swaps.delete_one({"_id": doc["_id"]})
    return payload


app.include_router(api_router)

# --- CORS -------------------------------------------------------------------
_raw_origins = os.environ.get('CORS_ORIGINS', '*')
_origins = [o.strip() for o in _raw_origins.split(',') if o.strip()]
# Credentials cannot be combined with a wildcard origin; the frontend doesn't use them.
_allow_credentials = _origins != ['*']
app.add_middleware(
    CORSMiddleware,
    allow_credentials=_allow_credentials,
    allow_origins=_origins or ['*'],
    allow_methods=["*"],
    allow_headers=["*"],
)
