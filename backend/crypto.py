"""Symmetric encryption for custodial hot-wallet private keys, at rest.

Private keys for the optional "Pay-once split" custodial flow are encrypted with
Fernet (AES-128-CBC + HMAC) before being written to MongoDB, so a database dump
alone never exposes usable keys. The key material is supplied via the
WALLET_ENCRYPTION_KEY environment variable (a urlsafe base64 32-byte Fernet key)
and is never logged. The user still receives their own plaintext recovery key in
Telegram so funds can never get permanently stuck.

Generate a key once with:
    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
"""
import os
import logging

from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)

_fernet = None


def available() -> bool:
    return bool(os.environ.get("WALLET_ENCRYPTION_KEY"))


def _get() -> Fernet:
    global _fernet
    if _fernet is not None:
        return _fernet
    key = os.environ.get("WALLET_ENCRYPTION_KEY")
    if not key:
        raise RuntimeError("WALLET_ENCRYPTION_KEY is not configured")
    _fernet = Fernet(key.encode() if isinstance(key, str) else key)
    return _fernet


def encrypt(plaintext: str) -> str:
    return _get().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    return _get().decrypt(ciphertext.encode()).decode()
