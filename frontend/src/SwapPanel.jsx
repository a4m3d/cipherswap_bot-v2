import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, ArrowRightLeft, ShieldCheck, Copy, Check, Loader2,
  EyeOff, Sparkles, Scissors, RefreshCw,
} from "lucide-react";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const CROWD = [5, 10, 25, 50, 100, 250, 500, 1000];
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

const STATUS_META = {
  PENDING_DEPOSIT: { label: "Waiting for deposit", cls: "st-wait" },
  KNOWN_DEPOSIT_TX: { label: "Deposit detected", cls: "st-info" },
  INCOMPLETE_DEPOSIT: { label: "Partial deposit", cls: "st-warn" },
  PROCESSING: { label: "Swapping…", cls: "st-info" },
  SUCCESS: { label: "Delivered", cls: "st-ok" },
  REFUNDED: { label: "Refunded", cls: "st-warn" },
  FAILED: { label: "Failed", cls: "st-bad" },
};

const qrSrc = (text) =>
  `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=1&bgcolor=0C1017&color=FFFFFF&data=${encodeURIComponent(text)}`;
const short = (a) => (a && a.length > 16 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a);
const nearestCrowd = (n) => {
  const x = Number(n);
  if (!isFinite(x) || x <= 0) return n;
  const higher = CROWD.find((c) => c >= x);
  if (higher) return higher;
  return CROWD.reduce((p, c) => (Math.abs(c - x) < Math.abs(p - x) ? c : p));
};

function Field({ label, children, hint }) {
  return (
    <div className="sw-field">
      <label className="sw-label">{label}</label>
      {children}
      {hint && <div className="sw-hint">{hint}</div>}
    </div>
  );
}

function DepositCard({ dep, meta }) {
  const [copied, setCopied] = useState(false);
  const m = STATUS_META[dep.status] || STATUS_META.PENDING_DEPOSIT;
  const copy = () => {
    navigator.clipboard.writeText(dep.deposit_address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="sw-dep" data-testid={`deposit-card-${dep.sid}`}>
      <div className="sw-dep-head">
        <span className={`sw-status ${m.cls}`} data-testid={`status-${dep.sid}`}>{m.label}</span>
        <span className="sw-dep-amt">{dep.amount_in} {meta.src_sym}</span>
      </div>
      <div className="sw-dep-body">
        <div className="sw-qr"><img src={qrSrc(dep.deposit_address)} alt="deposit qr" /></div>
        <div className="sw-dep-info">
          <div className="sw-kv"><span>Send on</span><b>{meta.srcNetName}</b></div>
          <div className="sw-kv"><span>You receive</span><b>~{dep.amount_out_formatted || "?"} {meta.dst_sym}</b></div>
          {dep.amount_out_usd && <div className="sw-kv"><span>~Value</span><b>${dep.amount_out_usd}</b></div>}
          {dep.time_estimate && <div className="sw-kv"><span>ETA</span><b>~{dep.time_estimate}s after deposit</b></div>}
        </div>
      </div>
      <div className="sw-addr-row">
        <code className="sw-addr" data-testid={`addr-${dep.sid}`}>{short(dep.deposit_address)}</code>
        <button className="sw-copy" onClick={copy} data-testid={`copy-${dep.sid}`}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div className="sw-full-addr">{dep.deposit_address}</div>
      {dep.deposit_memo && (
        <div className="sw-memo">Memo (required): <code>{dep.deposit_memo}</code></div>
      )}
      {dep.dest_tx_url && (
        <a className="sw-expl" href={dep.dest_tx_url} target="_blank" rel="noopener noreferrer">View on explorer ↗</a>
      )}
    </div>
  );
}

export default function SwapPanel({ open, onClose }) {
  const [networks, setNetworks] = useState([]);
  const [srcNet, setSrcNet] = useState("base");
  const [dstNet, setDstNet] = useState("");
  const [srcCoins, setSrcCoins] = useState([]);
  const [dstCoins, setDstCoins] = useState([]);
  const [srcSym, setSrcSym] = useState("");
  const [dstSym, setDstSym] = useState("");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [refund, setRefund] = useState("");
  const [blend, setBlend] = useState(false);
  const [split, setSplit] = useState(1);
  const [zeroTrace, setZeroTrace] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    if (!open || networks.length) return;
    axios.get(`${API}/web/networks`).then((r) => {
      const ns = r.data.networks || [];
      setNetworks(ns);
      if (!ns.some((n) => n.code === dstNet) && ns.length) setDstNet(ns.some((n) => n.code === "starknet") ? "starknet" : ns[0].code);
    }).catch(() => setError("Could not load networks."));
  }, [open, networks.length, dstNet]);

  useEffect(() => {
    if (!open || !srcNet) return;
    axios.get(`${API}/web/coins`, { params: { network: srcNet } })
      .then((r) => { setSrcCoins(r.data.coins || []); })
      .catch(() => setSrcCoins([]));
  }, [open, srcNet]);

  useEffect(() => {
    if (!open || !dstNet) return;
    axios.get(`${API}/web/coins`, { params: { network: dstNet } })
      .then((r) => { setDstCoins(r.data.coins || []); })
      .catch(() => setDstCoins([]));
  }, [open, dstNet]);

  useEffect(() => { setSrcSym(""); }, [srcNet]);
  useEffect(() => { setDstSym(""); }, [dstNet]);

  // Poll deposit statuses
  useEffect(() => {
    if (!result) return;
    const tick = async () => {
      const updated = await Promise.all(result.deposits.map(async (d) => {
        if (TERMINAL.has(d.status)) return d;
        try {
          const r = await axios.get(`${API}/web/swap/${d.sid}`);
          return { ...d, ...r.data };
        } catch { return d; }
      }));
      setResult((prev) => (prev ? { ...prev, deposits: updated } : prev));
    };
    pollRef.current = setInterval(tick, 12000);
    tick();
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.gid]);

  const effAmount = blend ? String(nearestCrowd(amount)) : amount;

  const submit = async () => {
    setError("");
    if (!srcSym || !dstSym) return setError("Pick a coin on both sides.");
    if (!amount || Number(amount) <= 0) return setError("Enter an amount.");
    if (!recipient.trim()) return setError("Enter a recipient address.");
    if (!refund.trim()) return setError("Enter a refund address.");
    setLoading(true);
    try {
      const r = await axios.post(`${API}/web/quote`, {
        origin_net: srcNet, src_sym: srcSym, dest_net: dstNet, dst_sym: dstSym,
        amount: effAmount, recipient: recipient.trim(), refund: refund.trim(),
        split, zero_trace: zeroTrace,
      });
      const srcNetName = (networks.find((n) => n.code === srcNet) || {}).name || srcNet;
      setResult({ ...r.data, srcNetName, deposits: r.data.deposits.map((d) => ({ ...d, status: "PENDING_DEPOSIT" })) });
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not create the deposit. Check the details and try again.");
    } finally {
      setLoading(false);
    }
  };

  const reset = () => { setResult(null); setError(""); };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="sw-overlay"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}
          data-testid="swap-overlay"
        >
          <motion.div
            className="sw-panel"
            initial={{ opacity: 0, y: 30, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            data-testid="swap-panel"
          >
            <div className="sw-head">
              <div className="sw-title">
                <ArrowRightLeft size={18} />
                <span>Secret Swap</span>
                <span className="sw-badge"><ShieldCheck size={12} /> non-custodial</span>
              </div>
              <button className="sw-close" onClick={onClose} data-testid="swap-close"><X size={18} /></button>
            </div>

            {!result ? (
              <div className="sw-body">
                <div className="sw-grid2">
                  <Field label="From network">
                    <select className="sw-select" value={srcNet} onChange={(e) => setSrcNet(e.target.value)} data-testid="src-net">
                      {networks.map((n) => <option key={n.code} value={n.code}>{n.name}</option>)}
                    </select>
                  </Field>
                  <Field label="From coin">
                    <select className="sw-select" value={srcSym} onChange={(e) => setSrcSym(e.target.value)} data-testid="src-coin">
                      <option value="">Select…</option>
                      {srcCoins.map((c) => <option key={c.assetId} value={c.symbol}>{c.symbol}</option>)}
                    </select>
                  </Field>
                </div>

                <div className="sw-grid2">
                  <Field label="To network">
                    <select className="sw-select" value={dstNet} onChange={(e) => setDstNet(e.target.value)} data-testid="dst-net">
                      {networks.map((n) => <option key={n.code} value={n.code}>{n.name}</option>)}
                    </select>
                  </Field>
                  <Field label="To coin">
                    <select className="sw-select" value={dstSym} onChange={(e) => setDstSym(e.target.value)} data-testid="dst-coin">
                      <option value="">Select…</option>
                      {dstCoins.map((c) => <option key={c.assetId} value={c.symbol}>{c.symbol}</option>)}
                    </select>
                  </Field>
                </div>

                <Field label="Amount" hint={blend && amount ? `Blend-In rounds to ${effAmount} ${srcSym || ""}` : undefined}>
                  <input className="sw-input" inputMode="decimal" placeholder="0.0" value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="amount-input" />
                </Field>

                <Field label={`Recipient address (on ${(networks.find(n=>n.code===dstNet)||{}).name || "destination"})`}>
                  <input className="sw-input mono" placeholder="where funds arrive" value={recipient}
                    onChange={(e) => setRecipient(e.target.value)} data-testid="recipient-input" />
                </Field>

                <Field label={`Refund address (on ${(networks.find(n=>n.code===srcNet)||{}).name || "source"})`} hint="Used only if the swap fails.">
                  <input className="sw-input mono" placeholder="refund goes here if anything fails" value={refund}
                    onChange={(e) => setRefund(e.target.value)} data-testid="refund-input" />
                </Field>

                <div className="sw-priv">
                  <div className="sw-priv-title"><ShieldCheck size={14} /> Privacy</div>
                  <div className="sw-toggles">
                    <button type="button" className={`sw-tog ${blend ? "on" : ""}`} onClick={() => setBlend(!blend)} data-testid="toggle-blend">
                      <Sparkles size={14} /> Blend-In
                    </button>
                    <button type="button" className={`sw-tog ${split > 1 ? "on" : ""}`}
                      onClick={() => setSplit(split >= 4 ? 1 : split + 1)} data-testid="toggle-split">
                      <Scissors size={14} /> Split {split > 1 ? `×${split}` : "off"}
                    </button>
                    <button type="button" className={`sw-tog ${zeroTrace ? "on" : ""}`} onClick={() => setZeroTrace(!zeroTrace)} data-testid="toggle-zt">
                      <EyeOff size={14} /> Zero-Trace
                    </button>
                  </div>
                  <div className="sw-priv-note">
                    Blend-In rounds to crowd amounts · Split creates separate deposits · Zero-Trace deletes the record on completion.
                  </div>
                </div>

                {error && <div className="sw-error" data-testid="swap-error">{error}</div>}

                <button className="sw-go" onClick={submit} disabled={loading} data-testid="get-deposit-btn">
                  {loading ? <><Loader2 size={16} className="sw-spin" /> Creating deposit…</> : <>Get deposit address</>}
                </button>
                <div className="sw-fineprint">Fresh single-use address per deposit. No bridge is 100% untraceable.</div>
              </div>
            ) : (
              <div className="sw-body">
                <div className="sw-result-head">
                  <div>
                    <div className="sw-result-title">{result.count} deposit{result.count > 1 ? "s" : ""} ready</div>
                    <div className="sw-result-sub">Send {result.src_sym} on {result.srcNetName} → receive {result.dst_sym}</div>
                  </div>
                  <button className="sw-new" onClick={reset} data-testid="new-swap-btn"><RefreshCw size={14} /> New</button>
                </div>
                {result.deposits.map((d) => <DepositCard key={d.sid} dep={d} meta={{ ...result, srcNetName: result.srcNetName }} />)}
                <div className="sw-fineprint">Statuses update automatically. Don't send to an expired quote.</div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
