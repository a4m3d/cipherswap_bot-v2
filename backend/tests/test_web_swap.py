"""Backend tests for CipherSwap /api/web/* Secret Swap endpoints."""
import os
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")

BASE_USDC_CA = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
BAD_CA = "0xdeadbeef"

STARKNET_RECIPIENT = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
BASE_REFUND = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae"


# ---------- health ----------
class TestHealth:
    def test_health(self):
        r = requests.get(f"{BASE_URL}/api/health", timeout=15)
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


# ---------- catalog: networks + coins ----------
class TestCatalog:
    def test_networks_returns_many(self):
        r = requests.get(f"{BASE_URL}/api/web/networks", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert "networks" in data
        nets = data["networks"]
        assert isinstance(nets, list) and len(nets) >= 30, f"only {len(nets)} networks"
        codes = {n["code"] for n in nets}
        assert "base" in codes and "starknet" in codes

    def test_coins_on_base(self):
        r = requests.get(f"{BASE_URL}/api/web/coins", params={"network": "base"}, timeout=30)
        assert r.status_code == 200
        coins = r.json().get("coins", [])
        assert coins, "no coins on base"
        syms = {c["symbol"] for c in coins}
        assert "USDC" in syms


# ---------- resolve-ca ----------
class TestResolveCA:
    def test_resolve_valid_base_usdc(self):
        r = requests.get(f"{BASE_URL}/api/web/resolve-ca",
                         params={"network": "base", "address": BASE_USDC_CA}, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["symbol"] == "USDC"
        assert d["network"] == "base"

    def test_resolve_unknown_ca(self):
        r = requests.get(f"{BASE_URL}/api/web/resolve-ca",
                         params={"network": "base", "address": BAD_CA}, timeout=30)
        assert r.status_code == 404


# ---------- quote validation ----------
class TestQuoteValidation:
    def _payload(self, **overrides):
        p = {
            "origin_net": "base", "src_sym": "USDC",
            "dest_net": "starknet", "dst_sym": "STRK",
            "amount": "5",
            "recipient": STARKNET_RECIPIENT,
            "refund": BASE_REFUND,
            "split": 1, "zero_trace": False,
        }
        p.update(overrides)
        return p

    def test_bad_recipient(self):
        r = requests.post(f"{BASE_URL}/api/web/quote",
                          json=self._payload(recipient="not_an_address"), timeout=30)
        assert r.status_code == 400
        assert "recipient" in r.json().get("detail", "").lower()

    def test_wrong_chain_refund(self):
        # Bitcoin address as refund for Base (EVM) should be rejected
        r = requests.post(f"{BASE_URL}/api/web/quote",
                          json=self._payload(refund="bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"),
                          timeout=30)
        assert r.status_code == 400
        assert "refund" in r.json().get("detail", "").lower()

    def test_zero_amount(self):
        r = requests.post(f"{BASE_URL}/api/web/quote",
                          json=self._payload(amount="0"), timeout=30)
        assert r.status_code == 400

    def test_bad_pair(self):
        r = requests.post(f"{BASE_URL}/api/web/quote",
                          json=self._payload(src_sym="NOPE_TOKEN"), timeout=30)
        assert r.status_code == 400


# ---------- quote happy path + status ----------
class TestQuoteHappyPath:
    def test_quote_and_status(self):
        payload = {
            "origin_net": "base", "src_sym": "USDC",
            "dest_net": "starknet", "dst_sym": "STRK",
            "amount": "5",
            "recipient": STARKNET_RECIPIENT,
            "refund": BASE_REFUND,
            "split": 1, "zero_trace": False,
        }
        r = requests.post(f"{BASE_URL}/api/web/quote", json=payload, timeout=45)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["count"] == 1
        assert d["src_sym"] == "USDC" and d["dst_sym"] == "STRK"
        assert len(d["deposits"]) == 1
        dep = d["deposits"][0]
        assert dep["deposit_address"]
        assert dep["sid"]
        assert dep["amount_in"] == "5"
        # amount_out may be numeric string
        assert dep.get("amount_out_formatted") is not None

        # status endpoint
        sid = dep["sid"]
        s = requests.get(f"{BASE_URL}/api/web/swap/{sid}", timeout=30)
        assert s.status_code == 200, s.text
        sd = s.json()
        assert sd["sid"] == sid
        assert sd["deposit_address"] == dep["deposit_address"]
        assert sd["status"] in ("PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX",
                                "INCOMPLETE_DEPOSIT", "PROCESSING")

    def test_unknown_sid_404(self):
        r = requests.get(f"{BASE_URL}/api/web/swap/deadbeefcafebabe", timeout=15)
        assert r.status_code == 404


# ---------- split quote returns N deposits ----------
class TestSplit:
    def test_split_x3(self):
        payload = {
            "origin_net": "base", "src_sym": "USDC",
            "dest_net": "starknet", "dst_sym": "STRK",
            "amount": "15",
            "recipient": STARKNET_RECIPIENT,
            "refund": BASE_REFUND,
            "split": 3, "zero_trace": False,
        }
        r = requests.post(f"{BASE_URL}/api/web/quote", json=payload, timeout=90)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["count"] == 3
        assert len(d["deposits"]) == 3
        addrs = {dep["deposit_address"] for dep in d["deposits"]}
        # Each chunk gets its own deposit address
        assert len(addrs) == 3
