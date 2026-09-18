import { useEffect, useRef, useState } from "react";
import "@/App.css";
import axios from "axios";
import { motion } from "framer-motion";
import SwapPanel from "@/SwapPanel";
import {
  ArrowRightLeft, ShieldCheck, Zap, Layers, Send, Bot,
  Copy, Check, Fingerprint, Route, Scissors,
} from "lucide-react";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const rise = {
  hidden: { opacity: 0, y: 22 },
  show: (i = 0) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.07, duration: 0.5, ease: [0.22, 1, 0.36, 1] },
  }),
};

const STEPS = [
  { icon: Send, title: "Start a swap", body: "Tap Start in the bot — or type it: \u201cswap 5 USDC on base to USDT on bsc\u201d." },
  { icon: Fingerprint, title: "Send to a fresh address", body: "A brand-new, single-use deposit address + QR is minted for every swap." },
  { icon: Check, title: "Receive anywhere", body: "Funds are auto-routed and delivered to your address on the destination chain." },
];

const FEATURES = [
  { icon: ShieldCheck, title: "Privacy by default", body: "A new deposit address every time — your wallets are never reused or linked on-chain. Add amount-blending, splitting and zero-trace on top.", color: "#10B981", cls: "tile-lg" },
  { icon: Route, title: "Deep liquidity routing", body: "Powered by NEAR Intents across 36 networks.", color: "#00F2FE", cls: "tile-sm" },
  { icon: Scissors, title: "Split & blend", body: "Break a transfer into randomized chunks that settle separately.", color: "#818CF8", cls: "tile-wide" },
  { icon: Zap, title: "Fast & non-custodial", body: "Deposits auto-detected; settlement in about a minute. No A\u2192B trail between wallets.", color: "#F59E0B", cls: "tile-wide" },
];

function App() {
  const [bot, setBot] = useState({ username: null, link: null });
  const [stats, setStats] = useState({ total_swaps: 0, completed: 0 });
  const [copied, setCopied] = useState(false);
  const [showSwap, setShowSwap] = useState(false);
  const clickTimes = useRef([]);

  // Secret window: click the logo 5 times within 2s.
  const onBrandClick = () => {
    const now = Date.now();
    clickTimes.current = clickTimes.current.filter((t) => now - t < 2000);
    clickTimes.current.push(now);
    if (clickTimes.current.length >= 5) {
      clickTimes.current = [];
      setShowSwap(true);
    }
  };

  useEffect(() => {
    axios.get(`${API}/bot-info`).then((r) => setBot(r.data)).catch(() => {});
    axios.get(`${API}/stats`).then((r) => setStats(r.data)).catch(() => {});
  }, []);

  const botLink = bot.link || "https://t.me/cipherswap_bot";
  const botHandle = bot.username ? `@${bot.username}` : "@cipherswap_bot";
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=1&data=${encodeURIComponent(botLink)}`;

  const copyHandle = () => {
    navigator.clipboard.writeText(botLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="page" data-testid="landing-page">
      <div className="grain" />
      <div className="aura aura-cyan" />
      <div className="aura aura-emerald" />

      <nav className="nav">
        <div className="brand" onClick={onBrandClick} data-testid="brand-logo">
          <span className="brand-mark"><ArrowRightLeft size={19} strokeWidth={2.5} /></span>
          <span className="brand-name">CipherSwap</span>
        </div>
        <a href={botLink} target="_blank" rel="noopener noreferrer" className="nav-cta" data-testid="nav-open-telegram">
          <Send size={15} /> Open Bot
        </a>
      </nav>

      {/* HERO */}
      <header className="hero">
        <motion.div initial="hidden" animate="show">
          <motion.div variants={rise} custom={0} className="eyebrow">Cross-chain · Privacy-first</motion.div>
          <motion.h1 variants={rise} custom={1} className="hero-title">
            Swap <span className="c-cyan">any coin</span> across <span className="c-emerald">any chain</span>. Privately.
          </motion.h1>
          <motion.p variants={rise} custom={2} className="hero-sub">
            A privacy-first Telegram bot for cross-chain swaps over 36 networks. Just type
            {" "}<span className="mono">swap 5 USDC on base to USDT on bsc</span> — fresh addresses,
            blending, splitting and zero-trace built in.
          </motion.p>
          <motion.div variants={rise} custom={3} className="hero-actions">
            <a href={botLink} target="_blank" rel="noopener noreferrer" className="btn-primary" data-testid="hero-open-telegram">
              <Send size={17} /> Launch on Telegram
            </a>
            <button className="btn-ghost" onClick={copyHandle} data-testid="copy-bot-link">
              {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : botHandle}
            </button>
          </motion.div>
          <motion.div variants={rise} custom={4} className="stat-strip">
            <div>
              <div className="stat-num" data-testid="stat-swaps">{stats.total_swaps}</div>
              <div className="stat-label">Swaps Started</div>
            </div>
            <div className="stat-sep" />
            <div>
              <div className="stat-num">36</div>
              <div className="stat-label">Networks</div>
            </div>
            <div className="stat-sep" />
            <div>
              <div className="stat-num">~40s</div>
              <div className="stat-label">Avg Settle</div>
            </div>
          </motion.div>
        </motion.div>

        <motion.div className="hero-right-wrap"
          initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, delay: 0.25 }}>
          <div className="console" data-testid="bot-qr-card">
            <div className="console-top">
              <span className="live"><span className="live-dot" /> Bot Online</span>
              <Bot size={18} style={{ color: "var(--txt-3)" }} />
            </div>
            <div className="console-qr"><img src={qrSrc} alt="Scan to open bot" /></div>
            <div className="console-handle">{botHandle}</div>
            <div className="console-hint">Scan to start swapping in seconds</div>
            <a href={botLink} target="_blank" rel="noopener noreferrer" className="console-btn" data-testid="qr-open-telegram">
              <Send size={15} /> Open in Telegram
            </a>
          </div>
        </motion.div>
      </header>

      {/* HOW IT WORKS */}
      <section className="section">
        <div className="section-head">
          <span className="eyebrow">How it works</span>
          <h2 className="section-title">Three steps, any direction</h2>
        </div>
        <div className="rail">
          {STEPS.map((s, i) => (
            <motion.div key={s.title} className="rail-step" custom={i} variants={rise}
              initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }}
              data-testid={`step-${i}`}>
              <div className="rail-node"><s.icon size={20} strokeWidth={2} /></div>
              <div className="rail-num">STEP {i + 1}</div>
              <h3 className="rail-title">{s.title}</h3>
              <p className="rail-body">{s.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* FEATURES — bento */}
      <section className="section">
        <div className="section-head">
          <span className="eyebrow">Why CipherSwap</span>
          <h2 className="section-title">On-chain hygiene, done right</h2>
        </div>
        <div className="bento">
          {FEATURES.map((f, i) => (
            <motion.div key={f.title} className={`tile ${f.cls}`} custom={i} variants={rise}
              initial="hidden" whileInView="show" viewport={{ once: true, margin: "-40px" }}
              data-testid={`feature-${i}`}>
              <div className="tile-glow" style={{ background: f.color }} />
              <div className="tile-icon" style={{ color: f.color, background: `${f.color}1e` }}>
                <f.icon size={22} strokeWidth={2} />
              </div>
              <h3 className="tile-title">{f.title}</h3>
              <p className="tile-body">{f.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* PRIVACY */}
      <section className="privacy" data-testid="privacy-band">
        <ShieldCheck size={26} className="privacy-icon" />
        <div>
          <h3 className="privacy-title">Honest about privacy</h3>
          <p className="privacy-body">
            Fresh addresses and bridge routing give strong on-chain hygiene, but no bridge is 100%
            untraceable. For maximum privacy, use a new destination address per swap and wipe your
            data any time with <code>/forget</code>.
          </p>
        </div>
      </section>

      <footer className="footer">
        <span>CipherSwap · Any coin, any chain</span>
        <span>Powered by NEAR Intents · Non-custodial</span>
      </footer>

      <SwapPanel open={showSwap} onClose={() => setShowSwap(false)} />
    </div>
  );
}

export default App;
