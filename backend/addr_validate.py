"""Chain-specific address validation.

Validation runs BEFORE any address is saved or used to create/submit a swap
(including the Pay-once Split custodial flow). It never alters an address; it
only accepts or rejects. Strict validators are used for the common chains
(EVM, Bitcoin family, Solana, Tron, XRP, NEAR, Starknet/Move, TON, Stellar,
Cardano); unknown/long-tail chains fall back to a conservative charset+length
check so legitimate users are not blocked while obvious garbage is rejected.

Cryptographic checks reuse established libraries: eth-utils (EVM checksum),
base58 (Base58Check), and bech32 (SegWit/bech32 checksum).
"""
import re

import base58
import bech32
from eth_utils import is_address as _evm_is_address

# --- network families -------------------------------------------------------
EVM = {
    "base", "eth", "arb", "op", "bsc", "pol", "avax", "gnosis", "scroll",
    "bera", "monad", "xlayer", "abs", "plasma", "hypercore", "pol_zkevm",
}
STARKNET = {"starknet"}
MOVE = {"aptos", "sui", "movement"}          # 0x-prefixed, up to 32 bytes hex
SOLANA = {"sol", "fogo", "aleo"}             # base58, 32 raw bytes
TRON = {"tron"}
XRP = {"xrp"}
NEAR = {"near"}
TON = {"ton"}
STELLAR = {"stellar"}
CARDANO = {"cardano"}
BTC = {"btc"}
LTC = {"ltc"}
DOGE = {"doge"}
DASH = {"dash"}
BCH = {"bch"}
ZEC = {"zec"}

_HEX_ADDR = re.compile(r"^0x[0-9a-fA-F]+$")
_NEAR_NAMED = re.compile(r"^(([a-z\d]+[\-_])*[a-z\d]+\.)*([a-z\d]+[\-_])*[a-z\d]+$")
_B32_CHARSET = set("qpzry9x8gf2tvdw0s3jn54khce6mua7l")
# XRP uses the same 58-character set as standard Base58 (just reordered).
_BASE58_SET = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
_STELLAR_RE = re.compile(r"^[A-Z2-7]{56}$")


def _b58check(addr: str) -> bool:
    try:
        base58.b58decode_check(addr)
        return True
    except Exception:
        return False


def _b58_raw_len(addr: str, n: int) -> bool:
    try:
        return len(base58.b58decode(addr)) == n
    except Exception:
        return False


def _segwit_ok(addr: str, hrp: str) -> bool:
    try:
        witver, _ = bech32.decode(hrp, addr)
        return witver is not None
    except Exception:
        return False


# --- per-family validators --------------------------------------------------
def _evm(a):
    return len(a) == 42 and a.startswith("0x") and _evm_is_address(a)


def _hex_upto_32bytes(a):  # Starknet felt / Move address
    return bool(_HEX_ADDR.match(a)) and 3 <= len(a) <= 66


def _solana(a):
    return 32 <= len(a) <= 44 and _b58_raw_len(a, 32)


def _tron(a):
    if not (a.startswith("T") and len(a) == 34):
        return False
    try:
        raw = base58.b58decode_check(a)
    except Exception:
        return False
    return len(raw) == 21 and raw[0] == 0x41


def _xrp(a):
    return a.startswith("r") and 25 <= len(a) <= 35 and all(c in _BASE58_SET for c in a)


def _near(a):
    al = a.lower()
    if re.fullmatch(r"[0-9a-f]{64}", al):        # implicit account
        return True
    return bool(2 <= len(al) <= 64 and _NEAR_NAMED.match(al))


def _ton(a):
    if re.fullmatch(r"-?\d+:[0-9a-fA-F]{64}", a):        # raw form
        return True
    return len(a) == 48 and bool(re.fullmatch(r"[A-Za-z0-9_\-]{48}", a))  # user-friendly


def _stellar(a):
    return a.startswith("G") and bool(_STELLAR_RE.match(a))


def _cardano(a):
    if a.startswith("addr1"):
        return 40 <= len(a) <= 130 and all(c in _B32_CHARSET for c in a[5:])
    if a.startswith(("Ae2", "DdzFF")):
        return _b58check(a) or 50 <= len(a) <= 130
    return False


def _btc(a):
    if a.startswith("bc1"):
        return _segwit_ok(a, "bc")
    if a[:1] in ("1", "3"):
        return 26 <= len(a) <= 35 and _b58check(a)
    return False


def _ltc(a):
    if a.startswith("ltc1"):
        return _segwit_ok(a, "ltc")
    if a[:1] in ("L", "M", "3"):
        return 26 <= len(a) <= 35 and _b58check(a)
    return False


def _doge(a):
    return a[:1] == "D" and 33 <= len(a) <= 35 and _b58check(a)


def _dash(a):
    return a[:1] == "X" and 33 <= len(a) <= 35 and _b58check(a)


def _bch(a):
    body = a.split(":", 1)[1] if a.startswith("bitcoincash:") else a
    if body[:1] in ("q", "p") and 42 <= len(body) <= 55:
        return all(c in _B32_CHARSET for c in body[1:])
    if body[:1] in ("1", "3"):
        return _b58check(body)
    return False


def _zec(a):
    if a.startswith(("t1", "t3")):
        return _b58check(a)
    if a.startswith(("zs", "u1", "zc")):     # shielded / unified (lenient)
        return len(a) >= 40
    return False


def _fallback(a):
    return 20 <= len(a) <= 120 and " " not in a


def _build_dispatch():
    d = {}
    for net in EVM:
        d[net] = _evm
    for net in STARKNET | MOVE:
        d[net] = _hex_upto_32bytes
    for net in SOLANA:
        d[net] = _solana
    d.update({
        "tron": _tron, "xrp": _xrp, "near": _near, "ton": _ton,
        "stellar": _stellar, "cardano": _cardano, "btc": _btc, "ltc": _ltc,
        "doge": _doge, "dash": _dash, "bch": _bch, "zec": _zec,
    })
    return d


_DISPATCH = _build_dispatch()


def has_strict_validator(network: str) -> bool:
    return (network or "").lower() in _DISPATCH


def validate_address(address: str, network: str) -> bool:
    """Return True if `address` is a plausibly valid address for `network`."""
    a = (address or "").strip()
    if not a or " " in a:
        return False
    fn = _DISPATCH.get((network or "").lower(), _fallback)
    try:
        return bool(fn(a))
    except Exception:
        return False
