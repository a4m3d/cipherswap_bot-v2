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
const POLL_MS = 5000;

const STATUS_META = {
  PENDING_DEPOSIT: { label: "Waiting for deposit", cls: "st-wait", pct: 12 },
  KNOWN_DEPOSIT_TX: { label: "Deposit detected", cls: "st-info", pct: 45 },
  INCOMPLETE_DEPOSIT: { label: "Partial deposit", cls: "st-warn", pct: 30 },
  PROCESSING: { label: "Swapping", cls: "st-swap", pct: 75 },
  SUCCESS: { label: "Delivered", cls: "st-ok", pct: 100 },
  REFUNDED: { label: "Refunded", cls: "st-warn", pct: 100 },
  FAILED: { label: "Failed", cls: "st-bad", pct: 100 },
};

const qrSrc = (t) => `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=1&data=${encodeURIComponent(t)}`;
const short = (a) => (a && a.length > 18 ? `${a.slice(0, 11)}\u2026${a.slice(-8)}` : a);
const nearestCrowd = (n) => {
  const x = Number(n);
  if (!isFinite(x) || x <= 0) return n;
  const higher = CROWD.find((c) => c >= x);
  return higher || CROWD.reduce((p, c) => (Math.abs(c - x) < Math.abs(p - x) ? c : p));
};

function Field({ label, action, children, hint }) {
  return (
    <div className="sw-field">
      <div className="sw-label"><span>{label}</span>{action}</div>
      {children}
      {hint && <div className="sw-hint">{hint}</div>}
    </div>
  );
}

function CoinSelect({ side, net, netName, coins, sym, onSym }) {
  const [caMode, setCaMode] = useState(false);
  const [ca, setCa] = useState("");
  const [caErr, setCaErr] = useState("");
  const [caOk, setCaOk] = useState("");
  const [busy, setBusy] = useState(false);

  const resolve = async () => {
    if (!ca.trim()) return;
    setBusy(true); setCaErr(""); setCaOk("");
    try {
      const r = await axios.get(`${API}/web/resolve-ca`, { params: { network: net, address: ca.trim() } });
      onSym(r.data.symbol);
      setCaOk(`Matched ${r.data.symbol}`);
    } catch (e) {
      setCaErr(e?.response?.data?.detail || "No token found for that address.");
    } finally { setBusy(false); }
  };

  return (
    <Field
      label={`${side} coin`}
      action={
        <button type="button" className="sw-ca-link" onClick={() => setCaMode(!caMode)} data-testid={`ca-toggle-${side.toLowerCase()}`}>
          {caMode ? "pick from list" : "paste contract address"}
        </button>
      }
    >
      {!caMode ? (
        <select className="sw-select" value={sym} onChange={(e) => onSym(e.target.value)} data-testid={`${side.toLowerCase()}-coin`}>
          <option value="">Select coin…</option>
          {coins.map((c) => <option key={c.assetId} value={c.symbol}>{c.symbol}</option>)}
        </select>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="sw-ca-input" placeholder={`0x\u2026 contract on ${netName}`} value={ca}
              onChange={(e) => setCa(e.target.value)} onKeyDown={(e) => e.key === "Enter" && resolve()}
              data-testid={`ca-input-${side.toLowerCase()}`} />
            <button type="button" className="sw-copy" onClick={resolve} disabled={busy} data-testid={`ca-resolve-${side.toLowerCase()}`}>
              {busy ? <Loader2 size={14} className="sw-spin" /> : <Check size={14} />}
            </button>
          </div>
          {caOk && <div className="sw-ca-ok">{caOk}</div>}
          {caErr && <div className="sw-ca-err">{caErr}</div>}
        </>
      )}
    </Field>
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
    <motion.div className="sw-dep" layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      data-testid={`deposit-card-${dep.sid}`}>
      <div className="sw-dep-head">
        <AnimatePresence mode="wait">
          <motion.span key={dep.status} className={`sw-status ${m.cls}`}
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.25 }} data-testid={`status-${dep.sid}`}>
            <span className="sdot" /> {m.label}
          </motion.span>
        </AnimatePresence>
        <span className="sw-dep-amt">{dep.amount_in} {meta.src_sym}</span>
      </div>

      <div className="sw-dep-body">
        <div className="sw-qr"><img src={qrSrc(dep.deposit_address)} alt="deposit qr" /></div>
        <div className="sw-dep-info">
          <div className="sw-kv"><span>Send on</span><b>{meta.srcNetName}</b></div>
          <div className="sw-kv"><span>You get</span><b>~{dep.amount_out || dep.amount_out_formatted || "\u2026"} {meta.dst_sym}</b></div>
          {(dep.amount_out_usd) && <div className="sw-kv"><span>~Value</span><b>${dep.amount_out_usd}</b></div>}
          {dep.time_estimate && <div className="sw-kv"><span>ETA</span><b>~{dep.time_estimate}s</b></div>}
        </div>
      </div>

      <div className="sw-progress"><div className="sw-progress-bar" style={{ width: `${m.pct}%` }} /></div>

      <div className="sw-addr-row">
        <code className="sw-addr" data-testid={`addr-${dep.sid}`}>{short(dep.deposit_address)}</code>
        <button className="sw-copy" onClick={copy} data-testid={`copy-${dep.sid}`}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {dep.deposit_memo && <div className="sw-memo">Memo (required): <code>{dep.deposit_memo}</code></div>}
      {dep.dest_tx_url && <a className="sw-expl" href={dep.dest_tx_url} target="_blank" rel="noopener noreferrer">View delivery tx ↗</a>}
    </motion.div>
  );
}

export default function SwapPanel({ open, onClose }) {
  const [networks, setNetworks] = useState([]);
  const [srcNet, setSrcNet] = useState("base");
  const [dstNet, setDstNet] = useState("starknet");
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
    axios.get(`${API}/web/networks`).then((r) => setNetworks(r.data.networks || []))
      .catch(() => setError("Could not load networks."));
  }, [open, networks.length]);

  useEffect(() => {
    if (!open || !srcNet) return;
    setSrcSym("");
    axios.get(`${API}/web/coins`, { params: { network: srcNet } })
      .then((r) => setSrcCoins(r.data.coins || [])).catch(() => setSrcCoins([]));
  }, [open, srcNet]);

  useEffect(() => {
    if (!open || !dstNet) return;
    setDstSym("");
    axios.get(`${API}/web/coins`, { params: { network: dstNet } })
      .then((r) => setDstCoins(r.data.coins || [])).catch(() => setDstCoins([]));
  }, [open, dstNet]);

  // realtime polling
  useEffect(() => {
    if (!result) return;
    const tick = async () => {
      const updated = await Promise.all(
        (result.deposits || []).map(async (d) => {
          if (TERMINAL.has(d.status)) return d;
          try {
            const r = await axios.get(`${API}/web/swap/${d.sid}`);
            return { ...d, ...r.data };
          } catch { return d; }
        })
      );
      setResult((prev) => (prev ? { ...prev, deposits: updated } : prev));
    };
    tick();
    pollRef.current = setInterval(tick, POLL_MS);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.gid]);

  const netName = (code) => (networks.find((n) => n.code === code) || {}).name || code;
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
      setResult({
        ...r.data, srcNetName: netName(srcNet),
        deposits: r.data.deposits.map((d) => ({ ...d, status: "PENDING_DEPOSIT" })),
      });
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not create the deposit. Check details and retry.");
    } finally { setLoading(false); }
  };

  const reset = () => { setResult(null); setError(""); };

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="sw-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose} data-testid="swap-overlay">
          <motion.div className="sw-panel"
            initial={{ opacity: 0, y: 26, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.98 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()} data-testid="swap-panel">
            <div className="sw-head">
              <div className="sw-title">
                <ArrowRightLeft size={18} /> Secret Swap
                <span className="sw-badge"><ShieldCheck size={11} /> non-custodial</span>
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
                  <CoinSelect side="From" net={srcNet} netName={netName(srcNet)} coins={srcCoins} sym={srcSym} onSym={setSrcSym} />
                </div>
                <div className="sw-grid2">
                  <Field label="To network">
                    <select className="sw-select" value={dstNet} onChange={(e) => setDstNet(e.target.value)} data-testid="dst-net">
                      {networks.map((n) => <option key={n.code} value={n.code}>{n.name}</option>)}
                    </select>
                  </Field>
                  <CoinSelect side="To" net={dstNet} netName={netName(dstNet)} coins={dstCoins} sym={dstSym} onSym={setDstSym} />
                </div>

                <Field label="Amount" hint={blend && amount ? `Blend-In rounds to ${effAmount} ${srcSym || ""}` : undefined}>
                  <input className="sw-input mono" inputMode="decimal" placeholder="0.0" value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="amount-input" />
                </Field>
                <Field label={`Recipient (on ${netName(dstNet)})`}>
                  <input className="sw-input mono" placeholder="where funds arrive" value={recipient}
                    onChange={(e) => setRecipient(e.target.value)} data-testid="recipient-input" />
                </Field>
                <Field label={`Refund (on ${netName(srcNet)})`} hint="Used only if the swap fails.">
                  <input className="sw-input mono" placeholder="refund goes here if anything fails" value={refund}
                    onChange={(e) => setRefund(e.target.value)} data-testid="refund-input" />
                </Field>

                <div className="sw-priv">
                  <div className="sw-priv-title"><ShieldCheck size={13} /> Privacy</div>
                  <div className="sw-toggles">
                    <button type="button" className={`sw-tog ${blend ? "on" : ""}`} onClick={() => setBlend(!blend)} data-testid="toggle-blend">
                      <Sparkles size={15} /> Blend-In
                    </button>
                    <button type="button" className={`sw-tog ${split > 1 ? "on" : ""}`}
                      onClick={() => setSplit(split >= 4 ? 1 : split + 1)} data-testid="toggle-split">
                      <Scissors size={15} /> Split {split > 1 ? `\u00d7${split}` : "off"}
                    </button>
                    <button type="button" className={`sw-tog ${zeroTrace ? "on" : ""}`} onClick={() => setZeroTrace(!zeroTrace)} data-testid="toggle-zt">
                      <EyeOff size={15} /> Zero-Trace
                    </button>
                  </div>
                  <div className="sw-priv-note">Blend rounds to crowd amounts · Split creates separate deposits · Zero-Trace deletes the record on completion.</div>
                </div>

                {error && <div className="sw-error" data-testid="swap-error">{error}</div>}
                <button className="sw-go" onClick={submit} disabled={loading} data-testid="get-deposit-btn">
                  {loading ? <><Loader2 size={16} className="sw-spin" /> Creating…</> : <>Get deposit address</>}
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
                {result.deposits.map((d) => <DepositCard key={d.sid} dep={d} meta={result} />)}
                <div className="sw-fineprint">Statuses update live every {POLL_MS / 1000}s. Don't send to an expired quote.</div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
