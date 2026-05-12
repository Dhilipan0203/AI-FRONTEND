"use client";

/**
 * GENAI RESEARCH — Production UI
 * ─────────────────────────────────────────────────────────────────────
 * BUG FIXED: /api/status and /api/chat returned 404 because the fetch
 *   calls used relative paths that don't resolve on Vercel deployments
 *   without a backend. The fix:
 *   1. All fetch calls now read BASE_URL from env (NEXT_PUBLIC_API_URL)
 *      with a fallback to "" (same-origin) so the app works both locally
 *      and when deployed against a separate backend.
 *   2. fetchStatus is wrapped in a try/catch that silently degrades —
 *      missing /api/status no longer throws or shows an error.
 *   3. sendMessage handles non-JSON responses (HTML error pages from
 *      Vercel's 404) by checking res.headers before JSON.parse.
 *
 * REBRAND: "Flux AI" → "GENAI Research"
 *   New aesthetic: deep-space monochrome with sharp teal/amber accents,
 *   editorial Syne + Fira Code typography, structural grid background.
 * ─────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send, Plus, MessageSquare, ExternalLink, Copy, Check,
  AlertCircle, Search, Trash2, LayoutDashboard,
  Bot, MessagesSquare, ChevronLeft, ChevronRight,
  Activity, TrendingUp, CheckCircle2, Clock, X,
  Layers, Radio, Cpu, Zap, Globe, FileText,
} from "lucide-react";

// ─── API base URL fix ─────────────────────────────────────────────────────────
// Set NEXT_PUBLIC_API_URL in your .env.local or Vercel env vars to point at
// your backend (e.g. https://my-genai-api.onrender.com).
// Leave it unset for same-origin deployments.
const BASE_URL =
  typeof process !== "undefined"
    ? (process.env.NEXT_PUBLIC_API_URL ?? "")
    : "";

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`, init);
  if (!res.ok) {
    const ct = res.headers.get("content-type") ?? "";
    // Vercel 404 pages are HTML, not JSON — surface a clean error
    if (!ct.includes("application/json")) {
      throw new Error(`API endpoint ${path} not found (${res.status}). Check NEXT_PUBLIC_API_URL.`);
    }
  }
  return res;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  fullContent?: string;
  sources?: string[];
  score?: number;
  timestamp: number;
  isStreaming?: boolean;
  isError?: boolean;
  isColdStart?: boolean;
}

interface ChatSession {
  id: string;
  title: string;
  timestamp: number;
}

interface PipelineResult {
  report?: string;
  answer?: string;
  sources_used?: string[];
  sources?: string[];
  critic_score?: number;
}

interface ApiResponse {
  success: boolean;
  error?: string;
  result?: PipelineResult;
}

type View = "dashboard" | "chat" | "agents";

interface AgentStatus {
  name: string;
  role: string;
  status: "done" | "error";
  duration_sec: number;
  progress: number;
  description: string;
}

interface LastRun {
  query: string;
  execution_time_sec: number;
  source_count: number;
  quality_score: number;
  agents: AgentStatus[];
}

interface StatusData {
  total_queries: number;
  successful_queries: number;
  failed_queries: number;
  success_rate: number;
  avg_response_time_sec: number;
  last_query_at: string | null;
  last_run: LastRun | null;
  searches_used: number;
  search_limit: number;
  searches_remaining: number;
}

interface AgentDisplayData {
  id: number;
  name: string;
  role: string;
  icon: React.ReactNode;
  color: string;
  status: "active" | "thinking" | "queued" | "done" | "error" | "idle";
  task: string;
  progress: number;
  duration_sec?: number;
}

// ─── Agent config ─────────────────────────────────────────────────────────────

const AGENT_ICON_MAP: Record<string, { icon: React.ReactNode; color: string }> = {
  Orchestrator: { icon: <Layers size={14} />,   color: "#c084fc" },
  Researcher:   { icon: <Globe size={14} />,    color: "#38bdf8" },
  Synthesizer:  { icon: <Cpu size={14} />,      color: "#2dd4bf" },
  Architect:    { icon: <FileText size={14} />, color: "#fb923c" },
  Validator:    { icon: <Radio size={14} />,    color: "#f472b6" },
};

const IDLE_AGENTS: AgentDisplayData[] = [
  { id: 1, name: "Orchestrator", role: "Master Controller",  icon: <Layers size={14} />,   color: "#c084fc", status: "idle", task: "Awaiting pipeline start",    progress: 0 },
  { id: 2, name: "Researcher",   role: "Data Intelligence",  icon: <Globe size={14} />,    color: "#38bdf8", status: "idle", task: "Awaiting research query",    progress: 0 },
  { id: 3, name: "Synthesizer",  role: "Knowledge Fusion",   icon: <Cpu size={14} />,      color: "#2dd4bf", status: "idle", task: "Awaiting search results",    progress: 0 },
  { id: 4, name: "Architect",    role: "Report Builder",     icon: <FileText size={14} />, color: "#fb923c", status: "idle", task: "Awaiting synthesised data",  progress: 0 },
  { id: 5, name: "Validator",    role: "Quality Gate",       icon: <Radio size={14} />,    color: "#f472b6", status: "idle", task: "Awaiting report",            progress: 0 },
];

function agentFromStatus(a: AgentStatus, idx: number): AgentDisplayData {
  const ui = AGENT_ICON_MAP[a.name] ?? { icon: <Zap size={14} />, color: "#64748b" };
  return {
    id: idx + 1, name: a.name, role: a.role,
    icon: ui.icon, color: ui.color,
    status: a.status === "done" ? "done" : "error",
    task: a.description, progress: a.progress, duration_sec: a.duration_sec,
  };
}

const PIPELINE_STAGES = [
  { name: "Orchestrator", icon: <Layers size={11} />,   color: "#c084fc", startSec: 0  },
  { name: "Researcher",   icon: <Globe size={11} />,    color: "#38bdf8", startSec: 3  },
  { name: "Synthesizer",  icon: <Cpu size={11} />,      color: "#2dd4bf", startSec: 10 },
  { name: "Architect",    icon: <FileText size={11} />, color: "#fb923c", startSec: 20 },
  { name: "Validator",    icon: <Radio size={11} />,    color: "#f472b6", startSec: 40 },
];

const STARTER_PROMPTS = [
  "Latest breakthroughs in quantum computing",
  "How do large language models actually work?",
  "Top AI coding assistants compared in 2026",
  "Current state of nuclear fusion energy",
];

const STORAGE_KEY = "genai-research-v1";
const MAX_SESSIONS = 30;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36); }
function hostnameOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url.slice(0, 40); }
}
function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function timeAgoISO(iso: string | null): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  return isNaN(ts) ? "—" : timeAgo(ts);
}
function sanitizeReport(text: string): string {
  return text
    .replace(/---\s*SOURCE:[^\n]*---/gi, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(/\]\([^)]*\)/g, "")
    .replace(/^https?:\/\/\S+$/gim, "")
    .replace(/^[A-Z][A-Z\s]{1,20}$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function parseInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0, idx = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[0].startsWith("**"))      parts.push(<strong key={idx++} style={{ fontWeight: 600, color: "var(--tx1)" }}>{m[2]}</strong>);
    else if (m[0].startsWith("*"))  parts.push(<em key={idx++} style={{ fontStyle: "italic", color: "var(--tx2)" }}>{m[3]}</em>);
    else if (m[0].startsWith("`"))  parts.push(<code key={idx++} style={{ padding: "1px 5px", borderRadius: 4, fontSize: "0.82em", fontFamily: "var(--mono)", background: "var(--srf3)", color: "var(--acc)", border: "1px solid var(--brd)" }}>{m[4]}</code>);
    else if (m[0].startsWith("["))  parts.push(<a key={idx++} href={m[6]} target="_blank" rel="noopener noreferrer" style={{ color: "var(--acc)", textDecoration: "underline", textUnderlineOffset: 3 }}>{m[5]}</a>);
    last = m.index + m[0].length; idx++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? "" : parts.length === 1 && typeof parts[0] === "string" ? parts[0] : <>{parts}</>;
}

function MarkdownContent({ content }: { content: string }) {
  const nodes: React.ReactNode[] = [];
  const lines = content.split("\n");
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      const lang = line.replace(/^```/, "").trim();
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) { code.push(lines[i]); i++; }
      nodes.push(<CodeBlock key={k++} code={code.join("\n")} lang={lang} />); i++; continue;
    }
    if (line.startsWith("# "))   { nodes.push(<h1 key={k++} style={{ fontSize: 18, fontWeight: 700, color: "var(--tx1)", margin: "1.2rem 0 0.4rem", fontFamily: "var(--display)" }}>{parseInline(line.slice(2))}</h1>); i++; continue; }
    if (line.startsWith("## "))  { nodes.push(<h2 key={k++} style={{ fontSize: 15, fontWeight: 600, color: "var(--tx1)", margin: "1rem 0 0.3rem" }}>{parseInline(line.slice(3))}</h2>); i++; continue; }
    if (line.startsWith("### ")) { nodes.push(<h3 key={k++} style={{ fontSize: 13, fontWeight: 600, color: "var(--tx2)", margin: "0.8rem 0 0.2rem" }}>{parseInline(line.slice(4))}</h3>); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { nodes.push(<hr key={k++} style={{ border: "none", borderTop: "1px solid var(--brd)", margin: "1rem 0" }} />); i++; continue; }
    if (/^[-*+] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) { items.push(lines[i].slice(2)); i++; }
      nodes.push(<ul key={k++} style={{ margin: "0.5rem 0", padding: 0, listStyle: "none" }}>{items.map((it, j) => <li key={j} style={{ display: "flex", gap: 8, alignItems: "flex-start", color: "var(--tx2)", fontSize: 13, lineHeight: 1.7, marginBottom: 2 }}><span style={{ color: "var(--acc)", marginTop: 2, flexShrink: 0 }}>›</span><span>{parseInline(it)}</span></li>)}</ul>); continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      let num = 1;
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(lines[i].replace(/^\d+\. /, "")); i++; }
      nodes.push(<ol key={k++} style={{ margin: "0.5rem 0", paddingLeft: 20 }}>{items.map((it, j) => <li key={j} style={{ color: "var(--tx2)", fontSize: 13, lineHeight: 1.7, marginBottom: 2 }}>{parseInline(it)}</li>)}</ol>); continue;
    }
    if (line.startsWith("> ")) {
      const bq: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) { bq.push(lines[i].slice(2)); i++; }
      nodes.push(<blockquote key={k++} style={{ borderLeft: "2px solid var(--acc)", paddingLeft: 12, margin: "0.75rem 0", fontStyle: "italic", color: "var(--tx3)" }}>{bq.map((b, j) => <p key={j} style={{ margin: 0 }}>{parseInline(b)}</p>)}</blockquote>); continue;
    }
    if (line.trim() === "") { i++; continue; }
    const pLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^#{1,6} /.test(lines[i]) && !lines[i].trimStart().startsWith("```") && !/^[-*+] /.test(lines[i]) && !/^\d+\. /.test(lines[i]) && !lines[i].startsWith("> ") && !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())) { pLines.push(lines[i]); i++; }
    if (pLines.length > 0) nodes.push(<p key={k++} style={{ color: "var(--tx2)", lineHeight: 1.75, margin: "0.4rem 0", fontSize: 13 }}>{parseInline(pLines.join(" "))}</p>);
  }
  return <div style={{ minWidth: 0 }}>{nodes}</div>;
}

// ─── CodeBlock ────────────────────────────────────────────────────────────────

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ margin: "0.75rem 0", borderRadius: 8, overflow: "hidden", border: "1px solid var(--brd)", background: "var(--bg0)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 12px", borderBottom: "1px solid var(--brd)", background: "var(--srf2)" }}>
        <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--tx4)", textTransform: "uppercase", letterSpacing: "0.1em" }}>{lang || "code"}</span>
        <button onClick={() => { navigator.clipboard.writeText(code).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); }} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: copied ? "var(--acc)" : "var(--tx4)", background: "none", border: "none", cursor: "pointer", padding: "2px 6px", borderRadius: 4, transition: "color 0.15s" }}>
          {copied ? <Check size={10} /> : <Copy size={10} />}{copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre style={{ overflow: "auto", padding: "12px 16px", fontSize: 12, lineHeight: 1.65, fontFamily: "var(--mono)", color: "var(--tx2)", margin: 0 }}><code>{code}</code></pre>
    </div>
  );
}

// ─── SourceCard ───────────────────────────────────────────────────────────────

function SourceCard({ url, index }: { url: string; index: number }) {
  return (
    <motion.a href={url} target="_blank" rel="noopener noreferrer"
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--brd)", background: "var(--srf2)", textDecoration: "none", transition: "all 0.15s" }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--acc)")}
      onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--brd)")}>
      <span style={{ width: 16, height: 16, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--acc-dim)", fontSize: 9, fontWeight: 700, color: "var(--acc)" }}>{index + 1}</span>
      <span style={{ fontSize: 11, color: "var(--tx3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--mono)" }}>{hostnameOf(url)}</span>
      <ExternalLink size={9} color="var(--tx4)" />
    </motion.a>
  );
}

// ─── ScoreBadge ───────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const [c, bg] = score >= 8 ? ["#2dd4bf", "rgba(45,212,191,0.1)"] : score >= 6 ? ["#fb923c", "rgba(251,146,60,0.1)"] : ["#f87171", "rgba(248,113,113,0.1)"];
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 600, color: c, background: bg, border: `1px solid ${c}33` }}>★ {score}/10</span>;
}

// ─── AgentCard ────────────────────────────────────────────────────────────────

const S_COLOR: Record<string, string> = { active: "#2dd4bf", thinking: "#fbbf24", queued: "#334155", error: "#f87171", done: "#2dd4bf", idle: "#2a3344" };
const S_LABEL: Record<string, string> = { active: "RUNNING", thinking: "THINKING", queued: "QUEUED", error: "ERROR", done: "DONE", idle: "IDLE" };

function AgentCard({ agent, index }: { agent: AgentDisplayData; index: number }) {
  const [hov, setHov] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        borderRadius: 10, border: `1px solid ${hov ? agent.color + "44" : "var(--brd)"}`,
        background: hov ? `linear-gradient(135deg, var(--srf2), ${agent.color}0a)` : "var(--srf1)",
        padding: "14px 16px", cursor: "default", transition: "all 0.2s",
        transform: hov ? "translateY(-1px)" : "none",
        boxShadow: hov ? `0 6px 20px ${agent.color}14` : "none",
      }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: agent.color + "18", border: `1px solid ${agent.color}33`, color: agent.color }}>{agent.icon}</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--tx1)" }}>{agent.name}</div>
            <div style={{ fontSize: 10, color: "var(--tx4)", letterSpacing: "0.05em" }}>{agent.role}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: S_COLOR[agent.status], boxShadow: agent.status === "active" ? `0 0 6px ${S_COLOR[agent.status]}` : "none" }} />
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: S_COLOR[agent.status] }}>{S_LABEL[agent.status]}</span>
        </div>
      </div>
      <p style={{ fontSize: 11, color: "var(--tx4)", marginBottom: 10, lineHeight: 1.5 }}>{agent.task}</p>
      {agent.duration_sec !== undefined && (
        <p style={{ fontSize: 10, color: "var(--tx5)", marginBottom: 6 }}>Duration: <span style={{ color: "var(--tx3)" }}>{agent.duration_sec}s</span></p>
      )}
      {agent.progress > 0 && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: "var(--tx5)" }}>Progress</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: agent.color }}>{agent.progress}%</span>
          </div>
          <div style={{ height: 2, borderRadius: 99, background: "var(--srf3)" }}>
            <div style={{ height: "100%", borderRadius: 99, background: `linear-gradient(90deg,${agent.color}88,${agent.color})`, width: `${agent.progress}%`, transition: "width 1s ease" }} />
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ─── Loading state (pipeline running) ────────────────────────────────────────

function LoadingAgents() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  let activeIdx = 0;
  for (let i = 0; i < PIPELINE_STAGES.length; i++) {
    if (elapsed >= PIPELINE_STAGES[i].startSec) activeIdx = i;
  }
  const current = PIPELINE_STAGES[activeIdx];
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#0f766e,#0e7490)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>
        <Activity size={13} color="white" />
      </div>
      <div style={{ flex: 1, minWidth: 0, padding: "12px 16px", borderRadius: "0 12px 12px 12px", background: "var(--srf1)", border: "1px solid var(--brd)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <motion.div animate={{ scale: [1, 1.12, 1], opacity: [0.7, 1, 0.7] }} transition={{ duration: 1.4, repeat: Infinity }}
            style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", background: current.color + "18", border: `1px solid ${current.color}44`, color: current.color, flexShrink: 0 }}>
            {current.icon}
          </motion.div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--tx1)" }}>{current.name}</span>
              <motion.span animate={{ opacity: [0, 1, 0] }} transition={{ duration: 1.1, repeat: Infinity }}
                style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", padding: "2px 6px", borderRadius: 99, color: current.color, background: current.color + "18" }}>ACTIVE</motion.span>
            </div>
            <p style={{ fontSize: 11, color: "var(--tx4)", margin: 0 }}>{current.name.toLowerCase()} agent processing…</p>
          </div>
          <span style={{ fontSize: 11, color: "var(--tx5)", fontFamily: "var(--mono)", flexShrink: 0 }}>{elapsed}s</span>
        </div>
        {/* Pipeline dots */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          {PIPELINE_STAGES.map((stage, i) => {
            const isDone = i < activeIdx, isActive = i === activeIdx;
            return (
              <div key={stage.name} style={{ display: "flex", alignItems: "center", flex: 1 }}>
                <motion.div animate={isActive ? { scale: [1, 1.5, 1] } : {}} transition={{ duration: 1.1, repeat: Infinity }}
                  style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: (isDone || isActive) ? stage.color : "var(--srf3)", boxShadow: isActive ? `0 0 7px ${stage.color}` : "none" }} title={stage.name} />
                {i < PIPELINE_STAGES.length - 1 && (
                  <div style={{ flex: 1, height: 1, margin: "0 4px", background: isDone ? `linear-gradient(90deg,${stage.color}60,${PIPELINE_STAGES[i+1].color}30)` : "var(--brd)" }} />
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex" }}>
          {PIPELINE_STAGES.map((stage, i) => (
            <div key={stage.name} style={{ flex: 1, textAlign: "center" }}>
              <span style={{ fontSize: 8, fontWeight: 500, color: i <= activeIdx ? stage.color : "var(--tx5)" }}>{stage.name.slice(0, 4)}</span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ─── ColdStartCard ───────────────────────────────────────────────────────────

function ColdStartCard({ onRetry }: { onRetry?: () => void }) {
  const [secs, setSecs] = useState(35);
  const [fired, setFired] = useState(false);
  useEffect(() => {
    if (secs <= 0) { if (!fired) { setFired(true); onRetry?.(); } return; }
    const t = setTimeout(() => setSecs(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secs, fired, onRetry]);
  return (
    <div style={{ padding: "12px 16px", borderRadius: "0 12px 12px 12px", background: "rgba(251,146,60,0.06)", border: "1px solid rgba(251,146,60,0.2)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
        <Clock size={13} color="#fb923c" style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <p style={{ fontSize: 13, fontWeight: 600, color: "#fb923c", margin: "0 0 3px" }}>Backend waking up</p>
          <p style={{ fontSize: 12, color: "rgba(251,146,60,0.7)", margin: 0, lineHeight: 1.5 }}>
            Server is starting (20–30s). Auto-retrying in <strong style={{ color: "#fb923c" }}>{secs}s</strong>
          </p>
        </div>
      </div>
      <div style={{ height: 2, borderRadius: 99, background: "rgba(251,146,60,0.1)", overflow: "hidden", marginBottom: 10 }}>
        <motion.div style={{ height: "100%", borderRadius: 99, background: "rgba(251,146,60,0.5)" }} initial={{ width: "100%" }} animate={{ width: `${(secs / 35) * 100}%` }} transition={{ duration: 0.9, ease: "linear" }} />
      </div>
      {onRetry && (
        <button onClick={() => { setFired(true); setSecs(0); onRetry(); }}
          style={{ fontSize: 12, color: "#fb923c", background: "none", border: "1px solid rgba(251,146,60,0.3)", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>
          ↺ Retry now
        </button>
      )}
    </div>
  );
}

// ─── Messages ────────────────────────────────────────────────────────────────

function UserMessage({ msg }: { msg: Message }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.22 }}
      style={{ display: "flex", justifyContent: "flex-end" }}>
      <div style={{ maxWidth: "76%", padding: "10px 16px", borderRadius: "12px 12px 4px 12px", color: "#f1f5f9", fontSize: 13, lineHeight: 1.65, background: "linear-gradient(135deg,#0f766e,#0e7490)", border: "1px solid rgba(45,212,191,0.25)" }}>
        {msg.content}
      </div>
    </motion.div>
  );
}

function AssistantMessage({ msg, onRetry }: { msg: Message; onRetry?: () => void }) {
  const sources = msg.sources ?? [];
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#0f766e,#0e7490)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>
        <Activity size={13} color="white" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {msg.isError ? (
          msg.isColdStart ? <ColdStartCard onRetry={onRetry} /> : (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 14px", borderRadius: "0 12px 12px 12px", background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.2)" }}>
              <AlertCircle size={13} color="#f87171" style={{ flexShrink: 0, marginTop: 1 }} />
              <p style={{ fontSize: 13, color: "#fca5a5", lineHeight: 1.6, margin: 0 }}>{msg.content}</p>
            </div>
          )
        ) : (
          <div style={{ padding: "12px 16px", borderRadius: "0 12px 12px 12px", background: "var(--srf1)", border: "1px solid var(--brd)", fontSize: 13, overflow: "hidden" }}>
            <MarkdownContent content={msg.content} />
            {msg.isStreaming && <span style={{ display: "inline-block", width: 2, height: "1em", background: "var(--acc)", marginLeft: 3, verticalAlign: "text-bottom", borderRadius: 1, animation: "cursorBlink 1s ease-in-out infinite" }} />}
          </div>
        )}
        {sources.length > 0 && !msg.isStreaming && (
          <div style={{ marginTop: 8 }}>
            <p style={{ fontSize: 10, fontWeight: 700, color: "var(--tx5)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 }}>Sources</p>
            <div style={{ display: "grid", gap: 4 }}>{sources.slice(0, 6).map((url, i) => <SourceCard key={url + i} url={url} index={i} />)}</div>
          </div>
        )}
        {msg.score !== undefined && !msg.isStreaming && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 10, color: "var(--tx5)", textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 600 }}>Quality</span>
            <ScoreBadge score={msg.score} />
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Search limit badge ───────────────────────────────────────────────────────

function SearchLimitBadge({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  const remaining = Math.max(0, limit - used);
  const [c, bg, bc] = pct < 70 ? ["#2dd4bf","rgba(45,212,191,0.08)","rgba(45,212,191,0.2)"]
    : pct < 90 ? ["#fb923c","rgba(251,146,60,0.08)","rgba(251,146,60,0.2)"]
    : ["#f87171","rgba(248,113,113,0.08)","rgba(248,113,113,0.2)"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 8, background: bg, border: `1px solid ${bc}`, fontSize: 10 }}>
      <Search size={9} color={c} />
      <span style={{ color: "var(--tx5)" }}>Searches:</span>
      <span style={{ fontWeight: 700, color: c, fontFamily: "var(--mono)" }}>{used}<span style={{ color: "var(--tx5)" }}>/{limit}</span></span>
      <div style={{ width: 48, height: 2, borderRadius: 99, background: "var(--srf3)", overflow: "hidden" }}>
        <motion.div style={{ height: "100%", borderRadius: 99, background: c }} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8 }} />
      </div>
      <span style={{ color: "var(--tx5)" }}>{remaining} left</span>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function DashboardView({ statusData, onNavigate }: { statusData: StatusData | null; onNavigate: (v: View) => void }) {
  const has = !!statusData && statusData.total_queries > 0;
  const metrics = [
    { label: "Active Agents", value: "5",      delta: has ? `${statusData!.successful_queries} completed` : "0 completed",      icon: <Activity size={14} />, color: "#c084fc" },
    { label: "Avg Response",  value: has ? `${statusData!.avg_response_time_sec}s` : "—",  delta: "per query",                   icon: <Clock size={14} />,    color: "#38bdf8" },
    { label: "Success Rate",  value: has ? `${statusData!.success_rate}%` : "—",    delta: has ? `${statusData!.total_queries} total` : "no data yet",     icon: <TrendingUp size={14} />, color: "#2dd4bf" },
    { label: "Tasks Done",    value: has ? String(statusData!.total_queries) : "0", delta: "this session",                        icon: <CheckCircle2 size={14} />, color: "#fb923c" },
  ];
  const agentActivity: AgentDisplayData[] = statusData?.last_run ? statusData.last_run.agents.map((a, i) => agentFromStatus(a, i)) : IDLE_AGENTS;
  const recentActivity = statusData?.last_run ? [
    { text: `Pipeline completed in ${statusData.last_run.execution_time_sec}s`,                                   color: "#2dd4bf" },
    { text: `Retrieved ${statusData.last_run.source_count} source${statusData.last_run.source_count !== 1 ? "s" : ""}`, color: "#38bdf8" },
    { text: `Quality score ${statusData.last_run.quality_score}/10`,                                              color: "#c084fc" },
    { text: `Query: "${statusData.last_run.query.slice(0, 45)}${statusData.last_run.query.length > 45 ? "…" : ""}"`, color: "#fb923c" },
  ] : [];
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "24px 28px 40px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--tx1)", letterSpacing: "-0.04em", margin: "0 0 4px", fontFamily: "var(--display)" }}>Command Center</h1>
          <p style={{ fontSize: 13, color: "var(--tx4)", margin: 0 }}>
            {has ? `${statusData!.total_queries} pipeline runs · ${statusData!.success_rate}% success · last run ${timeAgoISO(statusData!.last_query_at)}`
              : "Run a query to populate live analytics"}
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
          {metrics.map((m, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
              style={{ padding: "16px", borderRadius: 10, border: "1px solid var(--brd)", background: "var(--srf1)" }}>
              <div style={{ color: m.color, marginBottom: 10 }}>{m.icon}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: "var(--tx1)", letterSpacing: "-0.04em", fontFamily: "var(--display)" }}>{m.value}</div>
              <div style={{ fontSize: 11, color: "var(--tx4)", marginTop: 2 }}>{m.label}</div>
              <div style={{ fontSize: 10, color: m.color, marginTop: 6, fontWeight: 600 }}>{m.delta}</div>
            </motion.div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}
            style={{ borderRadius: 10, border: "1px solid var(--brd)", background: "var(--srf1)", padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: "var(--tx5)", textTransform: "uppercase", letterSpacing: "0.12em", margin: 0 }}>Agent Activity</p>
              <button onClick={() => onNavigate("agents")} style={{ fontSize: 11, color: "var(--acc)", background: "none", border: "none", cursor: "pointer" }}>View all →</button>
            </div>
            {!has ? <p style={{ fontSize: 11, color: "var(--tx5)", textAlign: "center", padding: "16px 0" }}>Run a query to see agent data</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {agentActivity.map((a, i) => (
                  <div key={a.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontSize: 11, width: 90, flexShrink: 0, color: "var(--tx4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                    <div style={{ flex: 1, height: 2, borderRadius: 99, background: "var(--srf3)" }}>
                      <motion.div style={{ height: "100%", borderRadius: 99, background: `linear-gradient(90deg,${a.color}66,${a.color})` }} initial={{ width: 0 }} animate={{ width: `${Math.max(a.progress, 5)}%` }} transition={{ duration: 1.2, delay: i * 0.1 }} />
                    </div>
                    <div style={{ fontSize: 11, width: 28, textAlign: "right", flexShrink: 0, color: a.color, fontFamily: "var(--mono)" }}>{a.progress}%</div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
            style={{ borderRadius: 10, border: "1px solid var(--brd)", background: "var(--srf1)", padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: "var(--tx5)", textTransform: "uppercase", letterSpacing: "0.12em", margin: 0 }}>Recent Activity</p>
              {statusData?.last_query_at && <span style={{ fontSize: 10, color: "var(--tx5)" }}>{timeAgoISO(statusData.last_query_at)}</span>}
            </div>
            {recentActivity.length === 0 ? <p style={{ fontSize: 11, color: "var(--tx5)", textAlign: "center", padding: "16px 0" }}>No pipeline runs yet</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {recentActivity.map((item, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: item.color, marginTop: 5 }} />
                    <p style={{ fontSize: 12, color: "var(--tx3)", margin: 0, lineHeight: 1.5 }}>{item.text}</p>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        </div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}
          style={{ borderRadius: 10, border: "1px solid var(--brd)", background: "var(--srf1)", padding: "16px 18px" }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: "var(--tx5)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 12 }}>Quick Actions</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {[["New Chat","chat"],["View Agents","agents"],["Run Research","chat"],["Check Pipeline","agents"]].map(([label, view], i) => (
              <button key={i} onClick={() => onNavigate(view as View)}
                style={{ padding: "7px 14px", fontSize: 12, borderRadius: 8, border: "1px solid var(--brd)", background: "var(--srf2)", color: "var(--tx3)", cursor: "pointer", transition: "all 0.15s" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--acc)"; e.currentTarget.style.color = "var(--acc)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--brd)"; e.currentTarget.style.color = "var(--tx3)"; }}>
                {label}
              </button>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// ─── Agents view ──────────────────────────────────────────────────────────────

function AgentsView({ statusData }: { statusData: StatusData | null }) {
  const [selected, setSelected] = useState<number | null>(null);
  const lastRun = statusData?.last_run ?? null;
  const agents: AgentDisplayData[] = lastRun ? lastRun.agents.map((a, i) => agentFromStatus(a, i)) : IDLE_AGENTS;
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "24px 28px 40px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--tx1)", letterSpacing: "-0.04em", margin: "0 0 4px", fontFamily: "var(--display)" }}>Agent Pipeline</h1>
          <p style={{ fontSize: 13, color: "var(--tx4)", margin: 0 }}>
            {lastRun ? `Last run · "${lastRun.query.slice(0, 45)}${lastRun.query.length > 45 ? "…" : ""}" · ${lastRun.execution_time_sec}s · ${lastRun.source_count} sources` : "5 agents · run a query to see execution data"}
          </p>
        </div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          style={{ borderRadius: 10, border: "1px solid var(--brd)", background: "var(--srf1)", padding: "16px 18px", marginBottom: 16 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: "var(--tx5)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 16 }}>Execution Timeline</p>
          <div style={{ display: "flex", alignItems: "center" }}>
            {agents.map((agent, i) => {
              const isDone = agent.status === "done", isActive = agent.status === "active" || agent.status === "thinking", lit = isDone || isActive;
              return (
                <div key={agent.id} style={{ display: "flex", alignItems: "center", flex: 1 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid ${lit ? agent.color : agent.status === "error" ? "#f87171" : "var(--srf3)"}`, background: lit ? agent.color + "18" : "var(--srf2)", color: lit ? agent.color : "var(--tx5)", boxShadow: lit ? `0 0 10px ${agent.color}40` : "none" }}>
                      {agent.icon}
                    </div>
                    <p style={{ fontSize: 8, fontWeight: 600, textAlign: "center", color: lit ? agent.color : "var(--tx5)", margin: 0 }}>{agent.name.slice(0, 4)}</p>
                  </div>
                  {i < agents.length - 1 && (
                    <div style={{ flex: 1, height: 1, margin: "0 6px 16px", background: lit ? `linear-gradient(90deg,${agents[i].color}60,${agents[i+1].color}25)` : "var(--brd)" }} />
                  )}
                </div>
              );
            })}
          </div>
        </motion.div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
          {agents.map((agent, i) => (
            <div key={agent.id} onClick={() => setSelected(selected === agent.id ? null : agent.id)}>
              <AgentCard agent={agent} index={i} />
              <AnimatePresence>
                {selected === agent.id && lastRun && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                    style={{ borderRadius: "0 0 10px 10px", border: "1px solid var(--brd)", borderTop: "none", background: "var(--srf1)", padding: "10px 14px", overflow: "hidden" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, color: "var(--tx5)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8 }}>Execution Log</p>
                    {[`Status: ${agent.status.toUpperCase()}`, `Duration: ${agent.duration_sec ?? 0}s`, `Progress: ${agent.progress}%`, agent.task].map((log, li) => (
                      <div key={li} style={{ fontSize: 11, color: "var(--tx4)", padding: "4px 0", borderBottom: "1px solid var(--brd)", display: "flex", gap: 8 }}>
                        <span style={{ color: "var(--tx5)", fontFamily: "var(--mono)" }}>{String(li + 1).padStart(2, "0")}</span>{log}
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Chat view ────────────────────────────────────────────────────────────────

function ChatView({ messages, isLoading, input, setInput, onSend, onRetry, bottomRef, searchesUsed, searchLimit }: {
  messages: Message[]; isLoading: boolean; input: string; setInput: (v: string) => void;
  onSend: () => void; onRetry: () => void; bottomRef: React.RefObject<HTMLDivElement | null>;
  searchesUsed?: number; searchLimit?: number;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = taRef.current; if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {messages.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: "0 24px", textAlign: "center" }}>
            <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.32 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg,#0f766e,#0e7490)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", boxShadow: "0 8px 24px rgba(15,118,110,0.3)" }}>
                <Activity size={20} color="white" />
              </div>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--tx1)", letterSpacing: "-0.04em", margin: "0 0 8px", fontFamily: "var(--display)" }}>Research anything</h2>
              <p style={{ fontSize: 13, color: "var(--tx4)", margin: "0 0 24px", maxWidth: 360 }}>5 autonomous agents search, read, synthesise and critique — end to end.</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, maxWidth: 520, margin: "0 auto" }}>
                {STARTER_PROMPTS.map((p, i) => (
                  <motion.button key={p} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + i * 0.05 }}
                    onClick={() => setInput(p)}
                    style={{ textAlign: "left", padding: "10px 14px", borderRadius: 9, border: "1px solid var(--brd)", background: "var(--srf1)", cursor: "pointer", transition: "all 0.15s" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--acc)"; e.currentTarget.style.background = "var(--acc-dim)"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--brd)"; e.currentTarget.style.background = "var(--srf1)"; }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <Search size={11} color="var(--tx5)" style={{ marginTop: 2, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: "var(--tx3)", lineHeight: 1.5 }}>{p}</span>
                    </div>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </div>
        ) : (
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 18 }}>
            <AnimatePresence initial={false}>
              {messages.map(msg => msg.role === "user"
                ? <UserMessage key={msg.id} msg={msg} />
                : <AssistantMessage key={msg.id} msg={msg} onRetry={msg.isColdStart ? onRetry : undefined} />
              )}
            </AnimatePresence>
            <AnimatePresence>{isLoading && !messages.some(m => m.isStreaming) && <LoadingAgents key="loading" />}</AnimatePresence>
            <div ref={bottomRef} style={{ height: 1 }} />
          </div>
        )}
      </div>
      {/* Input area */}
      <div style={{ flexShrink: 0, padding: "12px 16px 14px", borderTop: "1px solid var(--brd)", background: "var(--bg1)" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, padding: "10px 14px", borderRadius: 12, border: `1px solid ${isLoading ? "var(--brd)" : "var(--brd)"}`, background: "var(--srf1)", transition: "border-color 0.2s, box-shadow 0.2s" }}
            onFocusCapture={e => { const el = e.currentTarget; el.style.borderColor = "rgba(45,212,191,0.4)"; el.style.boxShadow = "0 0 0 3px rgba(45,212,191,0.07)"; }}
            onBlurCapture={e => { const el = e.currentTarget; el.style.borderColor = "var(--brd)"; el.style.boxShadow = "none"; }}>
            <textarea ref={taRef} value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
              placeholder={isLoading ? "Researching…" : "Ask anything — e.g. latest AI breakthroughs in 2026"}
              disabled={isLoading} rows={1}
              style={{ flex: 1, background: "transparent", fontSize: 13, color: "var(--tx1)", border: "none", outline: "none", resize: "none", lineHeight: 1.6, minHeight: 22, maxHeight: 160, fontFamily: "var(--font)", opacity: isLoading ? 0.5 : 1 }} />
            <button onClick={onSend} disabled={isLoading || !input.trim()}
              style={{ width: 32, height: 32, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: !isLoading && input.trim() ? "pointer" : "not-allowed", background: !isLoading && input.trim() ? "linear-gradient(135deg,#0f766e,#0e7490)" : "var(--srf3)", border: "none", transition: "all 0.15s", boxShadow: !isLoading && input.trim() ? "0 4px 12px rgba(15,118,110,0.3)" : "none" }}>
              <Send size={13} color={!isLoading && input.trim() ? "white" : "var(--tx5)"} />
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
            <p style={{ fontSize: 10, color: "var(--tx5)", margin: 0 }}>Enter to send · Shift+Enter for new line</p>
            {searchesUsed !== undefined && searchLimit !== undefined && <SearchLimitBadge used={searchesUsed} limit={searchLimit} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

const NAV_ITEMS: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={15} /> },
  { id: "chat",      label: "Research",  icon: <MessagesSquare  size={15} /> },
  { id: "agents",    label: "Agents",    icon: <Bot             size={15} /> },
];

function SidebarContent({ collapsed, activeView, sessions, activeId, onNavigate, onNewChat, onSelectChat, onDeleteSession, onClose, showClose }: {
  collapsed: boolean; activeView: View; sessions: ChatSession[]; activeId: string;
  onNavigate: (v: View) => void; onNewChat: () => void; onSelectChat: (id: string) => void;
  onDeleteSession: (id: string) => void; onClose: () => void; showClose: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 14px", height: 52, borderBottom: "1px solid var(--brd)", flexShrink: 0 }}>
        <div style={{ width: 26, height: 26, borderRadius: 8, background: "linear-gradient(135deg,#0f766e,#0e7490)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Activity size={13} color="white" />
        </div>
        {!collapsed && (
          <>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "var(--tx1)", letterSpacing: "-0.03em", fontFamily: "var(--display)", lineHeight: 1 }}>GENAI</div>
              <div style={{ fontSize: 9, color: "var(--tx5)", letterSpacing: "0.15em", textTransform: "uppercase", marginTop: 1 }}>Research</div>
            </div>
            {showClose && <button onClick={onClose} style={{ color: "var(--tx5)", background: "none", border: "none", cursor: "pointer", padding: 4 }}><X size={14} /></button>}
          </>
        )}
      </div>
      {/* Nav */}
      <div style={{ padding: "8px 8px 4px", flexShrink: 0 }}>
        {NAV_ITEMS.map(item => (
          <button key={item.id} onClick={() => { onNavigate(item.id); onClose(); }}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, marginBottom: 2, cursor: "pointer", border: `1px solid ${activeView === item.id ? "rgba(45,212,191,0.2)" : "transparent"}`, background: activeView === item.id ? "rgba(45,212,191,0.07)" : "transparent", color: activeView === item.id ? "var(--acc)" : "var(--tx4)", transition: "all 0.15s", fontFamily: "var(--font)" }}
            onMouseEnter={e => { if (activeView !== item.id) { e.currentTarget.style.background = "var(--srf2)"; e.currentTarget.style.color = "var(--tx2)"; } }}
            onMouseLeave={e => { if (activeView !== item.id) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--tx4)"; } }}>
            <span style={{ flexShrink: 0 }}>{item.icon}</span>
            {!collapsed && <span style={{ fontSize: 13, fontWeight: 500 }}>{item.label}</span>}
          </button>
        ))}
      </div>
      {/* Session list */}
      {!collapsed && (
        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}>
          <button onClick={() => { onNewChat(); onClose(); }}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, border: "1px dashed var(--brd)", background: "transparent", color: "var(--tx5)", cursor: "pointer", fontSize: 12, marginBottom: 12, marginTop: 4, fontFamily: "var(--font)", transition: "all 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--acc)"; e.currentTarget.style.color = "var(--acc)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--brd)"; e.currentTarget.style.color = "var(--tx5)"; }}>
            <Plus size={12} /><span>New research</span>
          </button>
          {sessions.length > 0 && (
            <>
              <p style={{ fontSize: 9, fontWeight: 700, color: "var(--tx5)", textTransform: "uppercase", letterSpacing: "0.14em", padding: "0 8px", marginBottom: 6 }}>Recent</p>
              {sessions.map(s => (
                <div key={s.id}
                  style={{ display: "flex", alignItems: "center", borderRadius: 7, marginBottom: 2, border: `1px solid ${s.id === activeId ? "rgba(45,212,191,0.18)" : "transparent"}`, background: s.id === activeId ? "rgba(45,212,191,0.06)" : "transparent", transition: "all 0.12s" }}
                  onMouseEnter={e => { if (s.id !== activeId) e.currentTarget.style.background = "var(--srf2)"; }}
                  onMouseLeave={e => { if (s.id !== activeId) e.currentTarget.style.background = "transparent"; }}>
                  <button onClick={() => { onSelectChat(s.id); onClose(); }} style={{ flex: 1, textAlign: "left", padding: "7px 10px", background: "none", border: "none", cursor: "pointer", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                      <MessageSquare size={10} color={s.id === activeId ? "var(--acc)" : "var(--tx5)"} style={{ marginTop: 2, flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <p style={{ fontSize: 11, color: s.id === activeId ? "var(--tx2)" : "var(--tx4)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: s.id === activeId ? 500 : 400, fontFamily: "var(--font)" }}>{s.title}</p>
                        <p style={{ fontSize: 9, color: "var(--tx5)", margin: "2px 0 0" }}>{timeAgo(s.timestamp)}</p>
                      </div>
                    </div>
                  </button>
                  <button onClick={e => { e.stopPropagation(); onDeleteSession(s.id); }}
                    style={{ padding: "4px 8px", background: "none", border: "none", cursor: "pointer", color: "var(--tx5)", opacity: 0, transition: "opacity 0.15s" }}
                    onMouseEnter={e => { e.currentTarget.style.color = "#f87171"; }}
                    onMouseLeave={e => { e.currentTarget.style.color = "var(--tx5)"; }}
                    onFocus={e => (e.currentTarget.style.opacity = "1")}
                    onBlur={e => (e.currentTarget.style.opacity = "0")}>
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {!collapsed && (
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--brd)", flexShrink: 0 }}>
          <p style={{ fontSize: 10, color: "var(--tx5)", textAlign: "center", margin: 0 }}>Multi-agent AI research</p>
        </div>
      )}
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [activeView, setActiveView]             = useState<View>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sessions, setSessions]                 = useState<ChatSession[]>([]);
  const [activeId, setActiveId]                 = useState(() => uid());
  const [allMessages, setAllMessages]           = useState<Record<string, Message[]>>({});
  const [input, setInput]                       = useState("");
  const [isLoading, setIsLoading]               = useState(false);
  const [statusData, setStatusData]             = useState<StatusData | null>(null);
  const bottomRef                               = useRef<HTMLDivElement>(null);
  const messages: Message[]                     = allMessages[activeId] ?? [];

  // ── Status fetch (gracefully handles missing endpoint) ────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/api/status");
      if (res.ok) setStatusData(await res.json());
    } catch { /* silently degrade — backend may not be deployed yet */ }
  }, []);

  // ── Restore from localStorage ─────────────────────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as { sessions: ChatSession[]; messages: Record<string, Message[]> };
        const cleaned: Record<string, Message[]> = {};
        for (const [id, msgs] of Object.entries(data.messages ?? {}))
          cleaned[id] = (msgs as Message[]).map(m => ({ ...m, isStreaming: false, content: m.fullContent ?? m.content, fullContent: undefined }));
        setSessions(data.sessions ?? []);
        setAllMessages(cleaned);
      }
    } catch { /* ignore */ }
    fetchStatus();
    const keepalive = setInterval(() => { fetch(`${BASE_URL}/api/status`).catch(() => {}); }, 8 * 60 * 1000);
    return () => clearInterval(keepalive);
  }, [fetchStatus]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions, messages: allMessages })); } catch { /* ignore */ }
  }, [sessions, allMessages]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, isLoading]);

  // ── Streaming reveal ──────────────────────────────────────────────────────
  useEffect(() => {
    const s = messages.find(m => m.isStreaming && m.fullContent);
    if (!s?.fullContent) return;
    const { id, content, fullContent } = s;
    if (content.length >= fullContent.length) {
      setAllMessages(prev => ({ ...prev, [activeId]: (prev[activeId] ?? []).map(m => m.id === id ? { ...m, isStreaming: false, content: fullContent } : m) }));
      return;
    }
    const t = setTimeout(() => {
      const next = Math.min(content.length + 20, fullContent.length);
      setAllMessages(prev => ({ ...prev, [activeId]: (prev[activeId] ?? []).map(m => m.id === id ? { ...m, content: fullContent.slice(0, next) } : m) }));
    }, 12);
    return () => clearTimeout(t);
  }, [messages, activeId]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const navigate      = useCallback((v: View) => { setActiveView(v); setMobileSidebarOpen(false); }, []);
  const newChat       = useCallback(() => { setActiveId(uid()); setInput(""); }, []);
  const selectChat    = useCallback((id: string) => { setActiveId(id); setInput(""); setActiveView("chat"); }, []);
  const deleteSession = useCallback((id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    setAllMessages(prev => { const n = { ...prev }; delete n[id]; return n; });
    if (id === activeId) setActiveId(uid());
  }, [activeId]);
  const clearChat     = useCallback(() => {
    setAllMessages(prev => ({ ...prev, [activeId]: [] }));
    setSessions(prev => prev.filter(s => s.id !== activeId));
  }, [activeId]);
  const retryLast     = useCallback(() => {
    const msgs = allMessages[activeId] ?? [];
    const lastUser = [...msgs].reverse().find(m => m.role === "user");
    if (!lastUser) return;
    setAllMessages(prev => ({ ...prev, [activeId]: (prev[activeId] ?? []).filter(m => m.id !== lastUser.id && !m.isError) }));
    setInput(lastUser.content);
  }, [allMessages, activeId]);

  // ── Send message (with robust API error handling) ─────────────────────────
  const sendMessage = useCallback(async () => {
    const query = input.trim();
    if (!query || isLoading) return;
    const userMsg: Message = { id: uid(), role: "user", content: query, timestamp: Date.now() };
    const aiId = uid();
    setInput(""); setIsLoading(true);
    setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] ?? []), userMsg] }));
    setSessions(prev => [{ id: activeId, title: query.length > 70 ? query.slice(0, 70) + "…" : query, timestamp: Date.now() }, ...prev.filter(s => s.id !== activeId)].slice(0, MAX_SESSIONS));
    try {
      // ─ BUG FIX: apiFetch validates content-type before JSON.parse ─────────
      const res  = await apiFetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: query }) });
      const data: ApiResponse = await res.json();
      if (!data.success) throw new Error(data.error ?? "The pipeline returned an error.");
      const r      = data.result ?? {};
      const report = sanitizeReport(r.report || r.answer || "The pipeline returned no content.");
      const sources = r.sources_used ?? r.sources ?? [];
      const score   = r.critic_score;
      setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] ?? []), { id: aiId, role: "assistant", content: "", fullContent: report, sources, score, timestamp: Date.now(), isStreaming: true }] }));
      fetchStatus();
    } catch (err) {
      const text = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      const isColdStart = text.includes("cold-start") || text.includes("took too long") || text.includes("524") || text.includes("502");
      setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] ?? []), { id: aiId, role: "assistant", content: text, timestamp: Date.now(), isError: true, isColdStart }] }));
    } finally { setIsLoading(false); }
  }, [input, isLoading, activeId, fetchStatus]);

  const activeTitle = sessions.find(s => s.id === activeId)?.title;

  // ── CSS variables injected at root ────────────────────────────────────────
  const cssVars = `
    :root {
      --bg0: #030405;
      --bg1: #060709;
      --srf1: rgba(255,255,255,0.025);
      --srf2: rgba(255,255,255,0.04);
      --srf3: rgba(255,255,255,0.07);
      --brd: rgba(255,255,255,0.07);
      --acc: #2dd4bf;
      --acc-dim: rgba(45,212,191,0.08);
      --tx1: #f0f4f8;
      --tx2: #b8c4d0;
      --tx3: #8896a4;
      --tx4: #4a5568;
      --tx5: #2a3344;
      --font: 'DM Sans', 'Outfit', system-ui, sans-serif;
      --display: 'Syne', 'Outfit', sans-serif;
      --mono: 'Fira Code', 'JetBrains Mono', monospace;
    }
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@300;400;500;600&family=Fira+Code:wght@300;400&display=swap');
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg0); color: var(--tx2); font-family: var(--font); }
    @keyframes cursorBlink { 0%,100%{opacity:1} 50%{opacity:0} }
    /* structural grid */
    body::before {
      content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
      background-image: linear-gradient(rgba(45,212,191,.012) 1px,transparent 1px), linear-gradient(90deg,rgba(45,212,191,.012) 1px,transparent 1px);
      background-size: 56px 56px;
    }
    /* subtle teal glow top-left */
    body::after {
      content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
      background: radial-gradient(ellipse 700px 500px at 0% 0%, rgba(45,212,191,0.04) 0%, transparent 65%),
                  radial-gradient(ellipse 600px 600px at 100% 100%, rgba(14,116,144,0.04) 0%, transparent 65%);
    }
    ::-webkit-scrollbar{width:3px;height:3px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:rgba(45,212,191,.2);border-radius:99px}
  `;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: cssVars }} />
      <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg0)", position: "relative", zIndex: 1 }}>

        {/* ── Desktop sidebar ───────────────────────────────────────────────── */}
        <aside style={{ display: "none", flexDirection: "column", flexShrink: 0, width: sidebarCollapsed ? 52 : 220, borderRight: "1px solid var(--brd)", background: "rgba(6,7,9,0.95)", transition: "width 0.25s ease", backdropFilter: "blur(20px)" }} className="lg-flex">
          <style>{`.lg-flex{display:flex!important}@media(max-width:1023px){.lg-flex{display:none!important}}`}</style>
          <SidebarContent collapsed={sidebarCollapsed} activeView={activeView} sessions={sessions} activeId={activeId} onNavigate={navigate} onNewChat={newChat} onSelectChat={selectChat} onDeleteSession={deleteSession} onClose={() => {}} showClose={false} />
          <button onClick={() => setSidebarCollapsed(p => !p)}
            style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", height: 36, margin: "0 8px 8px", borderRadius: 8, border: "1px solid var(--brd)", background: "transparent", color: "var(--tx5)", cursor: "pointer", fontSize: 11, gap: 6, fontFamily: "var(--font)", transition: "all 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--srf2)"; e.currentTarget.style.color = "var(--tx3)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--tx5)"; }}>
            {sidebarCollapsed ? <ChevronRight size={13} /> : <><ChevronLeft size={13} /><span>Collapse</span></>}
          </button>
        </aside>

        {/* ── Mobile sidebar overlay ────────────────────────────────────────── */}
        <AnimatePresence>
          {mobileSidebarOpen && (
            <>
              <motion.div key="ov" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={() => setMobileSidebarOpen(false)}
                style={{ position: "fixed", inset: 0, zIndex: 20, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
              <motion.aside key="sb" initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }}
                transition={{ type: "spring", damping: 28, stiffness: 280 }}
                style={{ position: "fixed", left: 0, top: 0, bottom: 0, width: 260, zIndex: 30, display: "flex", flexDirection: "column", borderRight: "1px solid var(--brd)", background: "rgba(6,7,9,0.98)", willChange: "transform", backdropFilter: "blur(20px)" }}>
                <SidebarContent collapsed={false} activeView={activeView} sessions={sessions} activeId={activeId} onNavigate={navigate} onNewChat={newChat} onSelectChat={selectChat} onDeleteSession={deleteSession} onClose={() => setMobileSidebarOpen(false)} showClose={true} />
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        {/* ── Main column ───────────────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, height: "100%", overflow: "hidden" }}>
          {/* Header */}
          <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 16px", height: 52, borderBottom: "1px solid var(--brd)", background: "rgba(6,7,9,0.92)", backdropFilter: "blur(20px)", flexShrink: 0, zIndex: 10 }}>
            {/* Mobile: logo + hamburger */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }} className="mobile-header">
              <style>{`.mobile-header{display:flex!important}.desktop-title{display:none!important}@media(min-width:1024px){.mobile-header{display:none!important}.desktop-title{display:flex!important}}`}</style>
              <button onClick={() => setMobileSidebarOpen(true)}
                style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer" }}>
                <div style={{ width: 26, height: 26, borderRadius: 7, background: "linear-gradient(135deg,#0f766e,#0e7490)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Activity size={12} color="white" />
                </div>
                <span style={{ fontSize: 13, fontWeight: 800, color: "var(--tx1)", fontFamily: "var(--display)", letterSpacing: "-0.03em" }}>GENAI</span>
              </button>
              {activeView === "chat" && activeTitle && (
                <span style={{ fontSize: 12, color: "var(--tx4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{activeTitle}</span>
              )}
            </div>
            {/* Desktop title */}
            <div style={{ flex: 1, minWidth: 0 }} className="desktop-title">
              {activeView === "chat" && activeTitle
                ? <p style={{ fontSize: 13, color: "var(--tx4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 400, margin: 0 }}>{activeTitle}</p>
                : <p style={{ fontSize: 13, color: "var(--tx4)", margin: 0, textTransform: "capitalize" }}>{activeView}</p>}
            </div>
            {activeView === "chat" && messages.length > 0 && (
              <button onClick={clearChat}
                style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 7, border: "1px solid var(--brd)", background: "transparent", color: "var(--tx4)", cursor: "pointer", fontSize: 12, fontFamily: "var(--font)", transition: "all 0.15s", flexShrink: 0 }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#f87171"; e.currentTarget.style.color = "#f87171"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--brd)"; e.currentTarget.style.color = "var(--tx4)"; }}>
                <Trash2 size={12} /><span>Clear</span>
              </button>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#2dd4bf", boxShadow: "0 0 6px #2dd4bf" }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: "#2dd4bf", letterSpacing: "0.1em" }}>LIVE</span>
            </div>
          </header>

          {/* Content */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            {activeView === "dashboard" && <DashboardView statusData={statusData} onNavigate={navigate} />}
            {activeView === "agents"    && <AgentsView statusData={statusData} />}
            {activeView === "chat"      && (
              <ChatView messages={messages} isLoading={isLoading} input={input} setInput={setInput}
                onSend={sendMessage} onRetry={retryLast} bottomRef={bottomRef}
                searchesUsed={statusData?.searches_used} searchLimit={statusData?.search_limit} />
            )}
          </div>
        </div>

        {/* ── Mobile bottom nav ──────────────────────────────────────────────── */}
        <nav style={{ display: "none", position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 20, borderTop: "1px solid var(--brd)", background: "rgba(6,7,9,0.96)", backdropFilter: "blur(20px)" }} className="mobile-nav">
          <style>{`.mobile-nav{display:flex!important}@media(min-width:1024px){.mobile-nav{display:none!important}}`}</style>
          {NAV_ITEMS.map(item => (
            <button key={item.id} onClick={() => navigate(item.id)}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "10px 0 12px", gap: 4, border: "none", background: "transparent", cursor: "pointer", color: activeView === item.id ? "var(--acc)" : "var(--tx5)", position: "relative", fontFamily: "var(--font)", transition: "color 0.15s" }}>
              {activeView === item.id && (
                <span style={{ position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)", width: 28, height: 2, borderRadius: 99, background: "var(--acc)" }} />
              )}
              <span style={{ transform: activeView === item.id ? "scale(1.1)" : "scale(1)", transition: "transform 0.15s" }}>{item.icon}</span>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em" }}>{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}