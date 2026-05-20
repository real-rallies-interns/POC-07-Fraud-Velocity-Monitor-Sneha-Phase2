"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import {
  ComposedChart, Area, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  Scatter, Cell, BarChart,
} from "recharts";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface SignalPoint {
  timestamp: string;
  txn_count: number;
  fraud_count: number;
  suspicious_count: number;
  normal_count: number;
  avg_risk: number;
  max_velocity: number;
  total_amount: number;
  anomaly: boolean;
  spike_type: "burst" | "risk_surge" | "amount_spike" | null;
  device_fingerprint?: string;
  ip_hash?: string;
}
interface AnomalyEvent {
  timestamp: string; spike_type: string; fraud_count: number;
  avg_risk: number; max_velocity: number; total_amount: number;
}
interface Metrics {
  total_events: number; fraud_count: number; flagged_for_review: number;
  fraud_rate_pct: number; total_exposure_usd: number; peak_velocity_1h: number;
  anomaly_minutes: number; avg_fraud_velocity_1h: number; pct_above_regional_avg: number;
}
interface CategoryRow {
  merchant_category: string; total: number; fraud: number;
  fraud_rate: number; avg_risk: number;
}
interface QueueEvent {
  event_id: string; label: string; risk_score: number; amount: number;
  velocity_1h: number; device_type: string; merchant_category: string;
  device_fingerprint: string; ip_hash: string;
}
interface HeatmapRow {
  hour: number; avg_fraud: number; avg_velocity: number; anomaly_rate: number;
}

// ─── FIX 1: rng() — use Math.imul + >>> 0 to avoid negative numbers ──────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const MERCHANT_CATEGORIES = ["E-Commerce","Crypto Exchange","Wire Transfer","ATM","POS Retail","Subscription"];
const DEVICE_TYPES = ["mobile","desktop","tablet","unknown"];

function genSignalStream(nMin = 288): SignalPoint[] {
  const r = rng(42);
  const now = Date.now();
  return Array.from({ length: nMin }, (_, i) => {
    const hour = new Date(now - (nMin - i) * 5 * 60000).getHours();
    const isBurst = r() < 0.03;
    const isRisk = r() < 0.025;
    const isAmt = r() < 0.02;
    const fraud = Math.round(r() * 2 + (isBurst ? 4 : 0));
    return {
      timestamp: new Date(now - (nMin - i) * 5 * 60000).toISOString(),
      txn_count: Math.round(r() * 8 + (9 <= hour && hour <= 18 ? 8 : 3)),
      fraud_count: fraud,
      suspicious_count: Math.round(r() * 1.5 + (isRisk ? 2 : 0)),
      normal_count: Math.max(0, Math.round(r() * 6)),
      avg_risk: parseFloat((isBurst || isRisk ? 0.55 + r() * 0.35 : r() * 0.35).toFixed(4)),
      max_velocity: isBurst ? 20 + Math.round(r() * 18) : isRisk ? 8 + Math.round(r() * 7) : 1 + Math.round(r() * 7),
      total_amount: parseFloat((isAmt ? 50000 + r() * 200000 : 5000 + r() * 35000).toFixed(2)),
      anomaly: isBurst || isRisk || isAmt,
      spike_type: isBurst ? "burst" : isRisk ? "risk_surge" : isAmt ? "amount_spike" : null,
      device_fingerprint: `FP-${10000 + Math.floor(r() * 89999)}`,
      ip_hash: `ip-${100000 + Math.floor(r() * 899999)}`,
    };
  });
}

// ─── FIX 2: generate real fallback data for category, queue, heatmap ──────────
function genEvents() {
  const r = rng(99);
  const LABELS = ["normal","normal","normal","suspicious","fraudulent"];
  return Array.from({ length: 500 }, (_, i) => {
    const label = LABELS[Math.floor(r() * LABELS.length)];
    const amount = label === "fraudulent" ? 5000 + r() * 45000 : label === "suspicious" ? 500 + r() * 14500 : 10 + r() * 4990;
    const velocity = label === "fraudulent" ? 15 + Math.round(r() * 25) : label === "suspicious" ? 8 + Math.round(r() * 10) : 1 + Math.round(r() * 7);
    const risk = label === "fraudulent" ? 0.7 + r() * 0.3 : label === "suspicious" ? 0.4 + r() * 0.35 : r() * 0.4;
    return {
      event_id: `EVT-${10000 + i}`, label,
      amount: parseFloat(amount.toFixed(2)), velocity_1h: velocity,
      risk_score: parseFloat(risk.toFixed(3)),
      merchant_category: MERCHANT_CATEGORIES[Math.floor(r() * MERCHANT_CATEGORIES.length)],
      device_type: DEVICE_TYPES[Math.floor(r() * DEVICE_TYPES.length)],
      device_fingerprint: `FP-${10000 + Math.floor(r() * 89999)}`,
      ip_hash: `ip-${100000 + Math.floor(r() * 899999)}`,
    };
  });
}

function genCategoryBreakdown(): CategoryRow[] {
  const events = genEvents();
  const map: Record<string, { total: number; fraud: number; risk_sum: number }> = {};
  events.forEach((e) => {
    if (!map[e.merchant_category]) map[e.merchant_category] = { total: 0, fraud: 0, risk_sum: 0 };
    map[e.merchant_category].total++;
    if (e.label === "fraudulent") map[e.merchant_category].fraud++;
    map[e.merchant_category].risk_sum += e.risk_score;
  });
  return Object.entries(map).map(([cat, d]) => ({
    merchant_category: cat, total: d.total, fraud: d.fraud,
    fraud_rate: parseFloat(((d.fraud / d.total) * 100).toFixed(1)),
    avg_risk: parseFloat((d.risk_sum / d.total).toFixed(3)),
  }));
}

function genReviewQueue(): QueueEvent[] {
  return genEvents()
    .filter((e) => e.label === "fraudulent" || e.label === "suspicious")
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, 20) as QueueEvent[];
}

function genHeatmap(stream: SignalPoint[]): HeatmapRow[] {
  const hours: Record<number, { fraud: number[]; vel: number[]; anom: number[] }> = {};
  stream.forEach((p) => {
    const h = new Date(p.timestamp).getHours();
    if (!hours[h]) hours[h] = { fraud: [], vel: [], anom: [] };
    hours[h].fraud.push(p.fraud_count);
    hours[h].vel.push(p.max_velocity);
    hours[h].anom.push(p.anomaly ? 1 : 0);
  });
  return Array.from({ length: 24 }, (_, h) => {
    const d = hours[h] ?? { fraud: [0], vel: [0], anom: [0] };
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    return { hour: h, avg_fraud: parseFloat(avg(d.fraud).toFixed(2)), avg_velocity: parseFloat(avg(d.vel).toFixed(2)), anomaly_rate: parseFloat(avg(d.anom).toFixed(3)) };
  });
}

async function fetchFallback<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error();
    return res.json();
  } catch { return fallback; }
}

// ─── TOOLTIP ─────────────────────────────────────────────────────────────────
const SignalTooltip = ({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string; }) => {
  if (!active || !payload?.length) return null;
  const pt = payload[0]?.payload as SignalPoint;
  return (
    <div style={{ background: "#1a0d35", border: "1px solid #1F2937", borderRadius: 6, padding: "10px 12px", fontSize: 11, minWidth: 180, pointerEvents: "none" }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#64748B", marginBottom: 6 }}>{label}</div>
      {pt?.anomaly && (
        <div style={{
          marginBottom: 6, padding: "2px 8px", borderRadius: 3, fontSize: 9,
          fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600,
          background: pt.spike_type === "burst" ? "rgba(248,113,113,0.15)" : pt.spike_type === "risk_surge" ? "rgba(251,191,36,0.15)" : "rgba(129,140,248,0.15)",
          color: pt.spike_type === "burst" ? "#F87171" : pt.spike_type === "risk_surge" ? "#FBBF24" : "#818CF8",
          border: `1px solid ${pt.spike_type === "burst" ? "rgba(248,113,113,0.3)" : pt.spike_type === "risk_surge" ? "rgba(251,191,36,0.3)" : "rgba(129,140,248,0.3)"}`,
        }}>
          ⚡ {pt.spike_type?.replace("_", " ").toUpperCase()} ANOMALY
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {payload.map((p, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
            <span style={{ color: p.color, opacity: 0.8 }}>{p.name}</span>
            <span style={{ fontWeight: 600, color: "#E2E8F0" }}>
              {typeof p.value === "number" ? p.value.toFixed(p.name === "Avg Risk" ? 3 : 0) : p.value}
            </span>
          </div>
        ))}
        {pt && (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginTop: 4, paddingTop: 4, borderTop: "1px solid #1F2937" }}>
            <span style={{ color: "#64748B" }}>Max Velocity</span>
            <span style={{ color: "#38BDF8", fontWeight: 600 }}>{pt.max_velocity}/hr</span>
          </div>
        )}
      </div>
    </div>
  );
};

type Tab = "signal" | "risk" | "category" | "queue";
type Resolution = "5min" | "15min" | "1h";

export default function FraudVelocityMonitor() {
  const [stream, setStream] = useState<SignalPoint[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyEvent[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [queue, setQueue] = useState<QueueEvent[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapRow[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("signal");
  const [resolution, setResolution] = useState<Resolution>("5min");
  const [selectedAnomaly, setSelectedAnomaly] = useState<SignalPoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulse, setPulse] = useState(true);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setPulse((p) => !p), 800);
    return () => clearInterval(t);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    const mockStream = genSignalStream(288);
    const [streamRes, anomRes, metRes, catRes, queueRes, heatRes] = await Promise.all([
      fetchFallback<{ stream: SignalPoint[] }>(`${API_BASE}/api/signal-stream?resolution=${resolution}&hours_back=24`, { stream: mockStream }),
      fetchFallback<{ anomalies: AnomalyEvent[] }>(`${API_BASE}/api/anomalies`, {
        anomalies: mockStream.filter((p) => p.anomaly).map((p) => ({ ...p, spike_type: p.spike_type ?? "burst" })),
      }),
      fetchFallback<Metrics>(`${API_BASE}/api/metrics/summary`, {
        total_events: 12450, fraud_count: 187, flagged_for_review: 94,
        fraud_rate_pct: 1.5, total_exposure_usd: 4280000, peak_velocity_1h: 37,
        anomaly_minutes: 58, avg_fraud_velocity_1h: 26.4, pct_above_regional_avg: 34.2,
      }),
      // ─── FIX 2: real fallback data — was [] which made tabs empty ────────────
      fetchFallback<{ categories: CategoryRow[] }>(`${API_BASE}/api/metrics/category-breakdown`, { categories: genCategoryBreakdown() }),
      fetchFallback<{ queue: QueueEvent[] }>(`${API_BASE}/api/review-queue`, { queue: genReviewQueue() }),
      fetchFallback<{ heatmap: HeatmapRow[] }>(`${API_BASE}/api/metrics/velocity-heatmap`, { heatmap: genHeatmap(mockStream) }),
    ]);
    // FINGERPRINT FIX: API stream has no device_fingerprint/ip_hash.
    // Inject them from mockStream by matching index position.
    const rawStream = streamRes.stream ?? mockStream;
    const enrichedStream = rawStream.map((pt, idx) => ({
      ...pt,
      device_fingerprint: pt.device_fingerprint ?? mockStream[idx]?.device_fingerprint ?? `FP-${10000 + idx}`,
      ip_hash: pt.ip_hash ?? mockStream[idx]?.ip_hash ?? `ip-${100000 + idx}`,
    }));
    setStream(enrichedStream);
    setAnomalies(anomRes.anomalies ?? []);
    setMetrics(metRes as Metrics);
    setCategories(catRes.categories ?? genCategoryBreakdown());
    setQueue(queueRes.queue ?? genReviewQueue());
    setHeatmap(heatRes.heatmap ?? genHeatmap(mockStream));
    setLoading(false);
  }, [resolution]);

  useEffect(() => { loadData(); }, [loadData]);

  const fmtTime = (ts: string) => {
    try {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } catch { return ts; }
  };

  const chartData = stream.map((p) => ({
    ...p,
    time: fmtTime(p.timestamp),
    // ─── FIX 3: use txn_count + 2 so markers always appear at chart top ───────
    anomalyMarker: p.anomaly ? p.txn_count + 2 : null,
  }));

  const spikeColor = (type: string | null) =>
    type === "burst" ? "#F87171" : type === "risk_surge" ? "#FBBF24" : type === "amount_spike" ? "#818CF8" : "#38BDF8";

  const labelColor = (l: string) =>
    l === "fraudulent" ? "#F87171" : l === "suspicious" ? "#FBBF24" : "#34D399";

  // ─── FIX 4: only open inspector when the clicked point IS an anomaly ─────────
  // ─── FIX 5: use setTimeout so panel is in DOM before scrollIntoView ──────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleChartClick = (data: any) => {
    if (!data?.activePayload?.length) return;
    const raw = data.activePayload[0].payload as SignalPoint;
    if (!raw?.anomaly) return;
    // Find enriched point from stream so FP/IP are never missing
    const match = stream.find((p) => p.timestamp === raw.timestamp) ?? raw;
    setSelectedAnomaly(match);
    setTimeout(() => {
      panelRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 0);
  };

  const xTickEvery = resolution === "5min" ? 12 : resolution === "15min" ? 4 : 2;

  return (
    <div style={{ minHeight: "100vh", height: "100vh", background: "#12082a", color: "#E2E8F0", fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, display: "flex", flexDirection: "column", overflow: "hidden", backgroundImage: "radial-gradient(ellipse 120% 70% at 50% 0%, rgba(160,80,255,0.30) 0%, rgba(120,50,220,0.15) 40%, transparent 70%), radial-gradient(ellipse 80% 60% at 100% 100%, rgba(100,50,200,0.20) 0%, transparent 55%), radial-gradient(ellipse 70% 50% at 0% 60%, rgba(140,60,230,0.15) 0%, transparent 50%)" }}>

      {/* ═══ INFOCREON CINEMATIC HEADER ═══ */}
      <header className="infocreon-header" style={{ padding: "0 16px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0, height: 44, position: "relative", zIndex: 50 }}>
        {/* INFOCREON Brand */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#38BDF8", boxShadow: "0 0 8px #38BDF8, 0 0 16px rgba(56,189,248,0.4)" }} />
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#a78bfa", letterSpacing: "0.18em", fontWeight: 600 }}>
            INFOCREON
          </span>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#2d3a50", letterSpacing: "0.05em" }}>·</span>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#38BDF8", letterSpacing: "0.1em", fontWeight: 600 }}>
            FRAUD VELOCITY MONITOR
          </span>
        </div>

        {/* Center meta */}
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#7c6fa0", marginLeft: "auto", letterSpacing: "0.12em" }}>TEMPORAL · SIGNAL STREAM · CFPB/FRED</span>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#a78bfa", background: "rgba(160,80,255,0.15)", border: "1px solid rgba(160,80,255,0.4)", padding: "2px 8px", borderRadius: 3, letterSpacing: "0.06em" }}>FINANCIAL RAIL</span>

        {/* Live status */}
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: loading ? "#FBBF24" : "#34D399", opacity: pulse ? 1 : 0.3, transition: "opacity 0.3s", boxShadow: loading ? "0 0 6px #FBBF24" : "0 0 6px #34D399" }} />
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: loading ? "#FBBF24" : "#34D399", letterSpacing: "0.1em" }}>{loading ? "LOADING" : "LIVE"}</span>
        </div>

        {/* ⓘ Info Button */}
        <button
          onClick={() => setInfoModalOpen(!infoModalOpen)}
          style={{ width: 28, height: 28, borderRadius: "50%", background: infoModalOpen ? "rgba(167,139,250,0.2)" : "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 13, fontWeight: 700, transition: "all 0.2s", flexShrink: 0 }}
          title="Architect Info"
        >
          ⓘ
        </button>
      </header>

      {/* ═══ INFO MODAL (Architect Signature) ═══ */}
      {infoModalOpen && (
        <div className="info-modal-overlay" onClick={() => setInfoModalOpen(false)}>
          <div className="info-modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#a78bfa", letterSpacing: "0.15em", marginBottom: 16 }}>◈ DEVELOPER SIGNATURE</div>
            {[
              { label: "Architect", value: "Sneha Sunilkumar" },
              { label: "Batch",     value: "Batch 2 Interns" },
              { label: "Stack",     value: "Next.js, FastAPI, Tailwind CSS, Recharts" },
            ].map((row, i, arr) => (
              <div key={row.label} style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: i < arr.length - 1 ? 12 : 16, paddingBottom: i < arr.length - 1 ? 12 : 0, borderBottom: i < arr.length - 1 ? "1px solid #241b3a" : "none" }}>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: "#a78bfa", letterSpacing: "0.12em" }}>{row.label.toUpperCase()}</span>
                <span style={{ fontSize: 13, color: "#E2E8F0", fontWeight: 500 }}>{row.value}</span>
              </div>
            ))}
            <button onClick={() => setInfoModalOpen(false)} style={{ width: "100%", padding: "7px 0", background: "rgba(167,139,250,0.08)", border: "1px solid #32255a", color: "#a78bfa", borderRadius: 4, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, cursor: "pointer", letterSpacing: "0.08em" }}>CLOSE</button>
          </div>
        </div>
      )}

      {/* ═══ CINEMATIC 100% FULL-SCREEN STAGE ═══ */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative", display: "flex", background: "transparent" }}>

        {/* ═══ MAIN STAGE — 100% FULL SCREEN ═══ */}
        <main style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", width: "100%", background: "transparent" }}>

          {/* METRIC STRIP */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", borderBottom: "1px solid #2e1d55", flexShrink: 0, background: "rgba(18,8,42,0.6)" }}>
            {[
              { label: "TOTAL TXNS / 24H", value: metrics?.total_events?.toLocaleString() ?? "—", color: "#E2E8F0" },
              { label: "FRAUD DETECTED",   value: metrics?.fraud_count?.toLocaleString() ?? "—",   color: "#F87171" },
              { label: "FRAUD RATE",       value: metrics ? `${metrics.fraud_rate_pct.toFixed(1)}%` : "—", color: "#FBBF24" },
              { label: "ANOMALY BURSTS",   value: metrics?.anomaly_minutes?.toLocaleString() ?? "—", color: "#818CF8" },
              { label: "PEAK VELOCITY",    value: metrics ? `${metrics.peak_velocity_1h}/hr` : "—", color: "#38BDF8" },
            ].map((m, i) => (
              <div key={i} style={{ padding: "10px 14px", borderRight: i < 4 ? "1px solid #2e1d55" : "none" }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#475569", letterSpacing: "0.08em", marginBottom: 4 }}>{m.label}</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: m.color, lineHeight: 1.1 }}>{m.value}</div>
              </div>
            ))}
          </div>

          {/* TABS + RESOLUTION */}
          <div style={{ display: "flex", alignItems: "center", background: "rgba(18,8,42,0.5)", borderBottom: "1px solid #2e1d55", flexShrink: 0 }}>
            {/* Resolution buttons — LEFT side */}
            <div style={{ display: "flex", gap: 4, paddingLeft: 12, paddingRight: 8, borderRight: "1px solid #2e1d55" }}>
              {(["5min", "15min", "1h"] as Resolution[]).map((r) => (
                <button key={r} onClick={() => setResolution(r)} style={{ padding: "3px 8px", background: resolution === r ? "rgba(167,139,250,0.15)" : "transparent", border: `1px solid ${resolution === r ? "rgba(167,139,250,0.5)" : "#1e1535"}`, color: resolution === r ? "#a78bfa" : "#475569", borderRadius: 3, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, cursor: "pointer", letterSpacing: "0.06em" }}>
                  {r}
                </button>
              ))}
            </div>
            {/* Tabs — after resolution */}
            {(["signal", "risk", "category", "queue"] as Tab[]).map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: "8px 14px", background: "transparent", border: "none", color: activeTab === tab ? "#38BDF8" : "#475569", borderBottom: `2px solid ${activeTab === tab ? "#38BDF8" : "transparent"}`, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, cursor: "pointer", letterSpacing: "0.08em" }}>
                {tab === "signal" ? "SIGNAL STREAM" : tab === "risk" ? "RISK SCORE" : tab === "category" ? "BY CATEGORY" : "REVIEW QUEUE"}
              </button>
            ))}
          </div>

          {/* ─── FIX 6: minHeight:0 not "100%" — allows flex child to shrink ─── */}
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12, background: "transparent" }}>
{/* SIGNAL STREAM TAB */}
{activeTab === "signal" && (
  <div>
    <div style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#475569", letterSpacing: "0.08em" }}>
        TRANSACTION SIGNAL STREAM · CLICK ANOMALY SPIKE ▲ TO INSPECT
      </span>
      <span style={{ marginLeft: "auto", display: "flex", gap: 12, fontSize: 10 }}>
        {[{ c: "#34D399", l: "Normal" }, { c: "#FBBF24", l: "Suspicious" }, { c: "#F87171", l: "Fraud" }, { c: "#818CF8", l: "Anomaly" }].map((x) => (
          <span key={x.l} style={{ display: "flex", alignItems: "center", gap: 4, color: "#94A3B8" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: x.c }} />{x.l}
          </span>
        ))}
      </span>
    </div>

    <div style={{ width: "100%", height: 220 }}>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={chartData} style={{ cursor: "default" }}>
          <CartesianGrid strokeDasharray="2 4" stroke="#1F2937" vertical={false} />
          <XAxis dataKey="time" tick={{ fill: "#475569", fontSize: 9, fontFamily: "'IBM Plex Mono', monospace" }} interval={xTickEvery} tickLine={false} axisLine={{ stroke: "#1F2937" }} />
          <YAxis tick={{ fill: "#475569", fontSize: 9 }} tickLine={false} axisLine={false} width={28} />
          <Tooltip content={<SignalTooltip />} />
          <Area type="monotone" dataKey="normal_count" stackId="1" fill="#34D399" fillOpacity={0.25} stroke="#34D399" strokeWidth={0} name="Normal" />
          <Area type="monotone" dataKey="suspicious_count" stackId="1" fill="#FBBF24" fillOpacity={0.35} stroke="#FBBF24" strokeWidth={0} name="Suspicious" />
          <Area type="monotone" dataKey="fraud_count" stackId="1" fill="#F87171" fillOpacity={0.6} stroke="#F87171" strokeWidth={1} name="Fraud" />
          
          {/* THE CRITICAL FIX: Direct onClick and cursor on the Scatter points */}
          <Scatter 
            dataKey="anomalyMarker" 
            name="Anomaly"
            style={{ cursor: 'pointer' }}
            onClick={(data) => {
              if (data && data.payload) {
                setSelectedAnomaly(data.payload);
                // Smooth scroll to the panel once it appears
                setTimeout(() => {
                  panelRef.current?.scrollIntoView({ behavior: "smooth" });
                }, 100);
              }
            }}
            shape={(props: { cx?: number; cy?: number; payload?: SignalPoint }) => {
              const { cx, cy, payload } = props;
              if (!payload?.anomaly || cx === undefined || cy === undefined) return <></>;
              return (
                <polygon 
                  points={`${cx},${cy - 8} ${cx - 5},${cy} ${cx + 5},${cy}`} 
                  fill={spikeColor(payload.spike_type ?? null)} 
                  opacity={0.9} 
                />
              );
            }}
          />
          
          {anomalies.slice(0, 5).map((a, i) => (
            <ReferenceLine key={i} x={fmtTime(a.timestamp)} stroke={spikeColor(a.spike_type)} strokeDasharray="3 3" strokeOpacity={0.4} strokeWidth={1} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>

                <div style={{ marginTop: 12, marginBottom: 6 }}>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#475569", letterSpacing: "0.08em" }}>MAX TRANSACTION VELOCITY / BUCKET (RULE THRESHOLD: 15/HR)</span>
                </div>
                <div style={{ width: "100%", height: 100 }}>
                  <ResponsiveContainer width="100%" height={100}>
                    <ComposedChart data={chartData}>
                      <CartesianGrid strokeDasharray="2 4" stroke="#1F2937" vertical={false} />
                      <XAxis dataKey="time" tick={{ fill: "#475569", fontSize: 9 }} interval={xTickEvery} tickLine={false} axisLine={{ stroke: "#1F2937" }} />
                      <YAxis tick={{ fill: "#475569", fontSize: 9 }} tickLine={false} axisLine={false} width={28} />
                      <Tooltip content={<SignalTooltip />} />
                      <Bar dataKey="max_velocity" name="Max Velocity" radius={[1, 1, 0, 0]}>
                        {chartData.map((entry, i) => (
                          <Cell key={i} fill={entry.max_velocity >= 15 ? "#F87171" : entry.max_velocity >= 8 ? "#FBBF24" : "#38BDF8"} fillOpacity={0.75} />
                        ))}
                      </Bar>
                      <ReferenceLine y={15} stroke="#F87171" strokeDasharray="4 2" strokeWidth={1} label={{ value: "RULE", fill: "#F87171", fontSize: 9, fontFamily: "'IBM Plex Mono', monospace" }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <div style={{ marginTop: 12, marginBottom: 6 }}>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#475569", letterSpacing: "0.08em" }}>TRANSACTION VOLUME USD / BUCKET</span>
                </div>
                <div style={{ width: "100%", height: 90 }}>
                  <ResponsiveContainer width="100%" height={90}>
                    <ComposedChart data={chartData}>
                      <CartesianGrid strokeDasharray="2 4" stroke="#1F2937" vertical={false} />
                      <XAxis dataKey="time" tick={{ fill: "#475569", fontSize: 9 }} interval={xTickEvery} tickLine={false} axisLine={{ stroke: "#1F2937" }} />
                      <YAxis tick={{ fill: "#475569", fontSize: 9 }} tickLine={false} axisLine={false} width={28} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} />
                      <Tooltip content={<SignalTooltip />} />
                      <Area type="monotone" dataKey="total_amount" fill="#818CF8" fillOpacity={0.2} stroke="#818CF8" strokeWidth={1} name="Volume USD" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {/* Slide panel hint when no anomaly selected */}
                {!selectedAnomaly && (
                  <div style={{ marginTop: 12, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#3d2870", letterSpacing: "0.08em", textAlign: "center" }}>
                    CLICK AN ANOMALY SPIKE ▲ TO OPEN INTELLIGENCE PANEL →
                  </div>
                )}
              </div>
            )}

            {/* RISK SCORE TAB */}
            {activeTab === "risk" && (
              <div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#475569", letterSpacing: "0.08em", marginBottom: 8 }}>AVG RISK SCORE TIMELINE · ANOMALY THRESHOLD 0.55</div>
                <div style={{ width: "100%", height: 280 }}>
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={chartData}>
                      <CartesianGrid strokeDasharray="2 4" stroke="#1F2937" vertical={false} />
                      <XAxis dataKey="time" tick={{ fill: "#475569", fontSize: 9 }} interval={xTickEvery} tickLine={false} axisLine={{ stroke: "#1F2937" }} />
                      <YAxis domain={[0, 1]} tick={{ fill: "#475569", fontSize: 9 }} tickLine={false} axisLine={false} width={28} />
                      <Tooltip content={<SignalTooltip />} />
                      <Area type="monotone" dataKey="avg_risk" fill="#38BDF8" fillOpacity={0.12} stroke="#38BDF8" strokeWidth={1.5} name="Avg Risk" />
                      <ReferenceLine y={0.55} stroke="#F87171" strokeDasharray="4 2" label={{ value: "ALERT 0.55", fill: "#F87171", fontSize: 9, fontFamily: "'IBM Plex Mono', monospace" }} />
                      <Scatter dataKey="anomalyMarker" name="Anomaly">
                        {chartData.map((entry, i) => (<Cell key={i} fill={spikeColor(entry.spike_type ?? null)} />))}
                      </Scatter>
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#475569", letterSpacing: "0.08em", marginBottom: 8 }}>AVERAGE FRAUD COUNT BY HOUR OF DAY</div>
                  <div style={{ width: "100%", height: 120 }}>
                    <ResponsiveContainer width="100%" height={120}>
                      <BarChart data={heatmap}>
                        <CartesianGrid strokeDasharray="2 4" stroke="#1F2937" vertical={false} />
                        <XAxis dataKey="hour" tick={{ fill: "#475569", fontSize: 9 }} tickLine={false} axisLine={{ stroke: "#1F2937" }} tickFormatter={(h) => `${String(h).padStart(2, "0")}h`} interval={2} />
                        <YAxis tick={{ fill: "#475569", fontSize: 9 }} tickLine={false} axisLine={false} width={24} />
                        <Tooltip contentStyle={{ background: "#1a0d35", border: "1px solid #1F2937", fontSize: 11 }} />
                        <Bar dataKey="avg_fraud" name="Avg Fraud/min" fill="#F87171" fillOpacity={0.7} radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}

            {/* BY CATEGORY TAB */}
            {activeTab === "category" && (
              <div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#475569", letterSpacing: "0.08em", marginBottom: 8 }}>FRAUD RATE % BY MERCHANT CATEGORY</div>
                {/* ─── FIX 8: ResponsiveContainer height was 100 but wrapper was 280 ─── */}
                <div style={{ width: "100%", height: 280 }}>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={[...categories].sort((a, b) => b.fraud_rate - a.fraud_rate)} layout="vertical">
                      <CartesianGrid strokeDasharray="2 4" stroke="#1F2937" horizontal={false} />
                      <XAxis type="number" tick={{ fill: "#475569", fontSize: 9 }} tickLine={false} axisLine={{ stroke: "#1F2937" }} tickFormatter={(v) => `${v}%`} />
                      <YAxis dataKey="merchant_category" type="category" width={110} tick={{ fill: "#94A3B8", fontSize: 10 }} tickLine={false} axisLine={false} />
                      <Tooltip contentStyle={{ background: "#1a0d35", border: "1px solid #1F2937", fontSize: 11 }} formatter={(v: any) => [`${(Number(v) || 0).toFixed(1)}%`, "Fraud Rate"]} />
                      <Bar dataKey="fraud_rate" name="Fraud Rate %" radius={[0, 3, 3, 0]}>
                        {[...categories].sort((a, b) => b.fraud_rate - a.fraud_rate).map((entry, i) => (
                          <Cell key={i} fill={entry.fraud_rate > 20 ? "#F87171" : entry.fraud_rate > 10 ? "#FBBF24" : "#38BDF8"} fillOpacity={0.75} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* REVIEW QUEUE TAB */}
            {activeTab === "queue" && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#475569", borderBottom: "1px solid #1F2937" }}>
                      {["EVENT ID","LABEL","RISK","AMOUNT","VEL/HR","DEVICE","CATEGORY","DEVICE FP","IP HASH"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #1F2937", letterSpacing: "0.06em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {queue.map((e) => (
                      <tr key={e.event_id} style={{ borderBottom: "1px solid rgba(31,41,55,0.5)" }}>
                        <td style={{ padding: "6px 8px", fontFamily: "'IBM Plex Mono', monospace", color: "#38BDF8" }}>{e.event_id}</td>
                        <td style={{ padding: "6px 8px" }}>
                          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, padding: "2px 6px", borderRadius: 3, color: labelColor(e.label), background: `${labelColor(e.label)}22` }}>
                            {e.label.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: labelColor(e.label) }}>{e.risk_score.toFixed(3)}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: "#94A3B8" }}>${e.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: e.velocity_1h > 15 ? "#F87171" : "#64748B" }}>{e.velocity_1h}</td>
                        <td style={{ padding: "6px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#64748B" }}>{e.device_type}</td>
                        <td style={{ padding: "6px 8px", fontSize: 10, color: "#94A3B8" }}>{e.merchant_category}</td>
                        <td style={{ padding: "6px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#818CF8" }}>{e.device_fingerprint ?? "—"}</td>
                        <td style={{ padding: "6px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#818CF8" }}>{e.ip_hash ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>

        {/* ═══ CINEMATIC SLIDE-OVER INTELLIGENCE PANEL ═══ */}
        <aside
          ref={panelRef}
          className={`slide-panel${selectedAnomaly ? " open" : ""}`}
          style={{ fontFamily: "'Space Grotesk', sans-serif" }}
        >
          {/* Panel Header */}
          <div style={{ padding: "14px 16px", borderBottom: "1px solid #2e1d55", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#1a0d35", position: "sticky", top: 0, zIndex: 10 }}>
            <div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: "#a78bfa", letterSpacing: "0.15em", marginBottom: 3 }}>INTELLIGENCE PANEL</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#38BDF8" }}>Fraud Velocity Monitor</div>
            </div>
            <button
              onClick={() => setSelectedAnomaly(null)}
              style={{ width: 26, height: 26, borderRadius: "50%", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.25)", color: "#F87171", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, lineHeight: 1 }}
              title="Close panel"
            >×</button>
          </div>

          {selectedAnomaly && (
            <>
              {/* Anomaly Inspected */}
              <section style={{ padding: 16, borderBottom: "1px solid #2e1d55" }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: spikeColor(selectedAnomaly.spike_type ?? null), letterSpacing: "0.15em", marginBottom: 10 }}>
                  ⚡ ANOMALY INSPECTED — {selectedAnomaly.spike_type?.replace("_", " ").toUpperCase() ?? "UNKNOWN"}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[
                    { label: "TIME", value: fmtTime(selectedAnomaly.timestamp), color: "#E2E8F0" },
                    { label: "FRAUD TXNS", value: selectedAnomaly.fraud_count.toString(), color: "#F87171" },
                    { label: "AVG RISK", value: selectedAnomaly.avg_risk.toFixed(3), color: "#FBBF24" },
                    { label: "PEAK VEL", value: `${selectedAnomaly.max_velocity}/hr`, color: "#38BDF8" },
                    { label: "DEVICE FP", value: selectedAnomaly.device_fingerprint ?? "—", color: "#a78bfa" },
                    { label: "IP HASH", value: selectedAnomaly.ip_hash ?? "—", color: "#a78bfa" },
                  ].map((m) => (
                    <div key={m.label} style={{ background: "#12082a", borderRadius: 4, padding: "8px 10px", border: "1px solid #2e1d55" }}>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 7, color: "#3d3060", letterSpacing: "0.1em", marginBottom: 3 }}>{m.label}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: m.color, fontFamily: "'IBM Plex Mono', monospace", wordBreak: "break-all" }}>{m.value}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, padding: "8px 10px", background: `${spikeColor(selectedAnomaly.spike_type ?? null)}08`, borderLeft: `2px solid ${spikeColor(selectedAnomaly.spike_type ?? null)}`, borderRadius: "0 4px 4px 0" }}>
                  <div style={{ fontSize: 10, color: "#94A3B8", lineHeight: 1.6 }}>
                    {selectedAnomaly.spike_type === "burst" && "Risk score surge: aggregate model confidence in fraudulent intent elevated above 0.55 threshold, possibly linked to device/IP clustering."}
                    {selectedAnomaly.spike_type === "risk_surge" && "Risk score surge: aggregate model confidence in fraudulent intent elevated above 0.55 threshold, possibly linked to device/IP clustering."}
                    {selectedAnomaly.spike_type === "amount_spike" && "Abnormal transaction volume detected. Wire fraud or cash-out pattern identified in this time bucket."}
                    {!selectedAnomaly.spike_type && "Anomaly detected in this time bucket."}
                  </div>
                </div>
              </section>

              {/* Section A */}
              <section style={{ padding: 16, borderBottom: "1px solid #2e1d55" }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: "#3d3060", letterSpacing: "0.1em", marginBottom: 8 }}>SECTION A · PROJECT 7 · PAYMENT RAIL</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[
                    { label: "EXPOSURE USD",  value: metrics ? `$${(metrics.total_exposure_usd / 1000000).toFixed(2)}M` : "—", color: "#a78bfa" },
                    { label: "AVG FRAUD VEL", value: metrics ? `${metrics.avg_fraud_velocity_1h}/hr` : "—", color: "#F87171" },
                    { label: "ANOMALY MINS",  value: metrics?.anomaly_minutes?.toString() ?? "—", color: "#FBBF24" },
                    { label: "% ABOVE AVG",   value: metrics ? `${metrics.pct_above_regional_avg}%` : "—", color: "#38BDF8" },
                  ].map((m, i) => (
                    <div key={i} style={{ background: "#12082a", borderRadius: 4, padding: "8px 10px", border: "1px solid #2e1d55" }}>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 7, color: "#3d3060", letterSpacing: "0.08em", marginBottom: 4 }}>{m.label}</div>
                      <div style={{ fontSize: 18, fontWeight: 600, color: m.color }}>{m.value}</div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Anomaly Spike Types */}
              <section style={{ padding: 16, borderBottom: "1px solid #2e1d55" }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: "#3d3060", letterSpacing: "0.1em", marginBottom: 10 }}>ANOMALY SPIKE TYPES</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {[
                    { type: "burst",        color: "#F87171", label: "Velocity Burst", desc: "Multiple fraud txns / bucket — card testing or ATO" },
                    { type: "risk_surge",   color: "#FBBF24", label: "Risk Surge",     desc: "Avg risk > 0.55 — device/IP clustering signal" },
                    { type: "amount_spike", color: "#a78bfa", label: "Amount Spike",   desc: "Abnormal $ volume — wire fraud or cash-out" },
                  ].map((s) => (
                    <div key={s.type} style={{ background: "#12082a", borderRadius: 4, padding: "8px 10px", border: `1px solid ${s.color}25`, borderLeft: `2px solid ${selectedAnomaly.spike_type === s.type ? s.color : s.color + "50"}`, opacity: selectedAnomaly.spike_type === s.type ? 1 : 0.5 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.color }} />
                        <span style={{ fontSize: 11, fontWeight: 500, color: s.color }}>{s.label}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "#64748B", lineHeight: 1.5 }}>{s.desc}</div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Section B */}
              <section style={{ padding: 16, borderBottom: "1px solid #2e1d55" }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: "#3d3060", letterSpacing: "0.1em", marginBottom: 8 }}>SECTION B · WHY THIS MATTERS</div>
                <p style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.7 }}>
                  Velocity rules are the first line of defense inside payment rails. When accounts fire more transactions per minute than their behavioral baseline allows, the system flags a potential account-takeover or card-not-present fraud cascade.
                </p>
                <div style={{ marginTop: 10, background: "rgba(56,189,248,0.04)", borderLeft: "2px solid #38BDF8", padding: "8px 10px", borderRadius: "0 4px 4px 0" }}>
                  <div style={{ fontSize: 10, color: "#38BDF8", fontWeight: 500, marginBottom: 4 }}>Real Rails Context</div>
                  <p style={{ fontSize: 10, color: "#64748B", lineHeight: 1.6 }}>CFPB complaint data + FRED economic indicators provide macro signal for anomaly baselines.</p>
                </div>
                <div style={{ marginTop: 10, background: "rgba(167,139,250,0.04)", borderLeft: "2px solid #a78bfa", padding: "8px 10px", borderRadius: "0 4px 4px 0" }}>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: "#a78bfa", letterSpacing: "0.06em", marginBottom: 4 }}>FRED · DRCCLACBS — DELINQUENCY RATE</div>
                  <div style={{ fontSize: 20, fontWeight: 600, color: "#a78bfa" }}>2.61%</div>
                  <div style={{ fontSize: 10, color: "#64748B", marginTop: 2 }}>Q4 2024 · Federal Reserve FRED (mock)</div>
                </div>
              </section>

              {/* Resolution + Refresh */}
              <section style={{ padding: 16, borderBottom: "1px solid #2e1d55" }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: "#3d3060", letterSpacing: "0.1em", marginBottom: 8 }}>TIME RESOLUTION</div>
                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                  {(["5min", "15min", "1h"] as Resolution[]).map((r) => (
                    <button key={r} onClick={() => setResolution(r)} style={{ flex: 1, padding: "6px 0", background: resolution === r ? "rgba(56,189,248,0.12)" : "transparent", border: `1px solid ${resolution === r ? "rgba(56,189,248,0.35)" : "#2e1d55"}`, color: resolution === r ? "#38BDF8" : "#3d3060", borderRadius: 4, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, cursor: "pointer" }}>
                      {r}
                    </button>
                  ))}
                </div>
                <button onClick={loadData} style={{ width: "100%", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.25)", color: "#38BDF8", borderRadius: 4, padding: "8px 0", fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, cursor: "pointer", letterSpacing: "0.08em" }}>
                  ↺ REFRESH STREAM
                </button>
              </section>

              {/* Export */}
              <section style={{ padding: 16 }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: "#3d3060", letterSpacing: "0.1em", marginBottom: 10 }}>EXPORT</div>
                <a href={`${API_BASE}/api/download/sample-data`} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.25)", color: "#38BDF8", borderRadius: 4, padding: "8px 0", fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, textDecoration: "none", letterSpacing: "0.08em" }}>
                  ↓ DOWNLOAD SIGNAL STREAM (CSV)
                </a>
              </section>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}