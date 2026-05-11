"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send, Plus, Zap, MessageSquare, ExternalLink, Copy, Check,
  AlertCircle, Sparkles, Search, Trash2, LayoutDashboard,
  Bot, MessagesSquare, ChevronLeft, ChevronRight,
  Activity, TrendingUp, CheckCircle2, Clock, X,
} from "lucide-react";

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

// ─── Status / real-data types ─────────────────────────────────────────────────

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
  icon: string;
  color: string;
  status: "active" | "thinking" | "queued" | "done" | "error" | "idle";
  task: string;
  progress: number;
  duration_sec?: number;
}

// ─── Agent UI config (static icon/color per agent name) ──────────────────────

const AGENT_UI: Record<string, { icon: string; color: string }> = {
  Orchestrator: { icon: "⬡", color: "#a78bfa" },
  Researcher:   { icon: "◈", color: "#38bdf8" },
  Synthesizer:  { icon: "◎", color: "#34d399" },
  Architect:    { icon: "◆", color: "#fb923c" },
  Validator:    { icon: "◉", color: "#f472b6" },
};

const IDLE_AGENTS: AgentDisplayData[] = [
  { id: 1, name: "Orchestrator", role: "Master Controller", icon: "⬡", color: "#a78bfa", status: "idle", task: "Waiting for pipeline to start",  progress: 0 },
  { id: 2, name: "Researcher",   role: "Data Intelligence", icon: "◈", color: "#38bdf8", status: "idle", task: "Waiting for research query",     progress: 0 },
  { id: 3, name: "Synthesizer",  role: "Knowledge Fusion",  icon: "◎", color: "#34d399", status: "idle", task: "Waiting for search results",     progress: 0 },
  { id: 4, name: "Architect",    role: "System Builder",    icon: "◆", color: "#fb923c", status: "idle", task: "Waiting for synthesized data",   progress: 0 },
  { id: 5, name: "Validator",    role: "Quality Gate",      icon: "◉", color: "#f472b6", status: "idle", task: "Waiting for report",             progress: 0 },
];

function agentFromStatus(a: AgentStatus, idx: number): AgentDisplayData {
  const ui = AGENT_UI[a.name] ?? { icon: "◉", color: "#64748b" };
  return {
    id: idx + 1,
    name: a.name,
    role: a.role,
    icon: ui.icon,
    color: ui.color,
    status: a.status === "done" ? "done" : "error",
    task: a.description,
    progress: a.progress,
    duration_sec: a.duration_sec,
  };
}

const STARTER_PROMPTS = [
  "What are the latest breakthroughs in quantum computing?",
  "Explain how large language models actually work",
  "Compare the top AI coding assistants in 2026",
  "What's the current state of nuclear fusion energy?",
];

const STORAGE_KEY = "flux-ai-v1";
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

// ─── Report sanitizer ────────────────────────────────────────────────────────

function sanitizeReport(text: string): string {
  return text
    // Remove --- SOURCE: ... --- separator lines
    .replace(/---\s*SOURCE:[^\n]*---/gi, '')
    // Remove markdown images: ![alt](url)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Remove markdown image refs: ![alt][ref]
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    // Remove broken link fragments ](url "title") leftover
    .replace(/\]\([^)]*\)/g, '')
    // Remove bare http(s) URLs on their own line
    .replace(/^https?:\/\/\S+$/gim, '')
    // Remove website navigation lines (ALL CAPS single words: HOME, WORLD etc.)
    .replace(/^[A-Z][A-Z\s]{1,20}$/gm, '')
    // Collapse 3+ blank lines into 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Markdown ────────────────────────────────────────────────────────────────

function parseInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0, idx = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[0].startsWith("**")) parts.push(<strong key={idx++} className="font-semibold text-white">{m[2]}</strong>);
    else if (m[0].startsWith("*")) parts.push(<em key={idx++} className="italic text-slate-300">{m[3]}</em>);
    else if (m[0].startsWith("`")) parts.push(<code key={idx++} className="px-1.5 py-0.5 rounded text-[0.82em] font-mono bg-white/[0.09] text-violet-300 border border-white/[0.08]">{m[4]}</code>);
    else if (m[0].startsWith("[")) parts.push(<a key={idx++} href={m[6]} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">{m[5]}</a>);
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
    if (line.startsWith("# "))   { nodes.push(<h1 key={k++} className="text-xl font-bold text-white mt-5 mb-2 first:mt-0">{parseInline(line.slice(2))}</h1>); i++; continue; }
    if (line.startsWith("## "))  { nodes.push(<h2 key={k++} className="text-[16px] font-semibold text-slate-100 mt-4 mb-1.5 first:mt-0">{parseInline(line.slice(3))}</h2>); i++; continue; }
    if (line.startsWith("### ")) { nodes.push(<h3 key={k++} className="text-[14px] font-semibold text-slate-200 mt-3 mb-1 first:mt-0">{parseInline(line.slice(4))}</h3>); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { nodes.push(<hr key={k++} className="border-white/[0.08] my-4" />); i++; continue; }
    if (/^[-*+] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) { items.push(lines[i].slice(2)); i++; }
      nodes.push(<ul key={k++} className="my-2.5 space-y-1 pl-4">{items.map((it, j) => <li key={j} className="text-slate-300 leading-relaxed list-none flex gap-2 before:text-indigo-500 before:content-['•'] before:flex-shrink-0">{parseInline(it)}</li>)}</ul>); continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(lines[i].replace(/^\d+\. /, "")); i++; }
      nodes.push(<ol key={k++} className="my-2.5 space-y-1 pl-5 list-decimal marker:text-indigo-500">{items.map((it, j) => <li key={j} className="text-slate-300 leading-relaxed pl-0.5">{parseInline(it)}</li>)}</ol>); continue;
    }
    if (line.startsWith("> ")) {
      const bq: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) { bq.push(lines[i].slice(2)); i++; }
      nodes.push(<blockquote key={k++} className="border-l-2 border-indigo-500/50 pl-3.5 my-2.5 italic text-slate-400">{bq.map((b, j) => <p key={j}>{parseInline(b)}</p>)}</blockquote>); continue;
    }
    if (line.trim() === "") { i++; continue; }
    const pLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^#{1,6} /.test(lines[i]) && !lines[i].trimStart().startsWith("```") && !/^[-*+] /.test(lines[i]) && !/^\d+\. /.test(lines[i]) && !lines[i].startsWith("> ") && !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())) { pLines.push(lines[i]); i++; }
    if (pLines.length > 0) nodes.push(<p key={k++} className="text-slate-300 leading-[1.75] my-1.5 first:mt-0 last:mb-0">{parseInline(pLines.join(" "))}</p>);
  }
  return <div className="space-y-0.5 min-w-0">{nodes}</div>;
}

// ─── CodeBlock ────────────────────────────────────────────────────────────────

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-3 rounded-lg overflow-hidden border border-white/[0.08] bg-[#0d0d14]">
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-white/[0.06] bg-white/[0.02]">
        <span className="text-[10px] font-mono text-slate-600 uppercase tracking-wider">{lang || "code"}</span>
        <button onClick={() => { navigator.clipboard.writeText(code).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); }} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300 transition-colors">
          {copied ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 text-[12.5px] leading-[1.65] font-mono text-slate-300"><code>{code}</code></pre>
    </div>
  );
}

// ─── SourceCard ───────────────────────────────────────────────────────────────

function SourceCard({ url, index }: { url: string; index: number }) {
  return (
    <motion.a href={url} target="_blank" rel="noopener noreferrer"
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.07] transition-all group no-underline">
      <span className="w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center bg-indigo-500/15 border border-indigo-500/25 text-[9px] font-bold text-indigo-400">{index + 1}</span>
      <span className="text-[11px] text-slate-400 group-hover:text-slate-300 truncate flex-1">{hostnameOf(url)}</span>
      <ExternalLink size={9} className="text-slate-700 group-hover:text-slate-500 flex-shrink-0" />
    </motion.a>
  );
}

// ─── ScoreBadge ───────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const cls = score >= 8 ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
    : score >= 6 ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
    : "text-red-400 bg-red-500/10 border-red-500/20";
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${cls}`}>★ {score}/10</span>;
}

// ─── AgentCard ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = { active: "#34d399", thinking: "#fbbf24", queued: "#334155", error: "#f87171", done: "#34d399", idle: "#334155" };
const STATUS_LABEL: Record<string, string> = { active: "RUNNING", thinking: "THINKING", queued: "QUEUED", error: "ERROR", done: "DONE", idle: "IDLE" };

function AgentCard({ agent, index }: { agent: AgentDisplayData; index: number }) {
  const [hov, setHov] = useState(false);
  const hex = agent.color.replace("#", "");
  const match = hex.match(/.{2}/g);
  const rgb = match ? match.map(h => parseInt(h, 16)).join(",") : "167,139,250";
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.07 }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      className="rounded-xl border p-4 cursor-pointer transition-all duration-200"
      style={{
        background: hov ? `linear-gradient(135deg,rgba(255,255,255,0.05),rgba(${rgb},0.07))` : "rgba(255,255,255,0.02)",
        borderColor: hov ? agent.color + "44" : "rgba(255,255,255,0.07)",
        transform: hov ? "translateY(-1px)" : "none",
        boxShadow: hov ? `0 8px 30px ${agent.color}18` : "none",
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-base"
            style={{ background: agent.color + "18", border: `1px solid ${agent.color}33`, color: agent.color }}>{agent.icon}</div>
          <div>
            <div className="text-[13px] font-semibold text-slate-200">{agent.name}</div>
            <div className="text-[10px] text-slate-600">{agent.role}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLOR[agent.status], boxShadow: agent.status === "active" ? `0 0 6px ${STATUS_COLOR[agent.status]}` : "none" }} />
          <span className="text-[9px] font-bold tracking-wider" style={{ color: STATUS_COLOR[agent.status] }}>{STATUS_LABEL[agent.status]}</span>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">{agent.task}</p>
      {agent.duration_sec !== undefined && (
        <p className="text-[10px] text-slate-700 mb-2">Duration: <span className="text-slate-500">{agent.duration_sec}s</span></p>
      )}
      {agent.progress > 0 && (
        <div>
          <div className="flex justify-between mb-1"><span className="text-[10px] text-slate-700">Progress</span><span className="text-[10px] font-semibold" style={{ color: agent.color }}>{agent.progress}%</span></div>
          <div className="h-0.5 rounded-full bg-white/[0.05]">
            <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${agent.progress}%`, background: `linear-gradient(90deg,${agent.color}88,${agent.color})` }} />
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ─── LoadingAgents ────────────────────────────────────────────────────────────

const PIPELINE_STAGES = [
  { name: "Orchestrator", role: "Master Controller", icon: "⬡", color: "#a78bfa", startSec: 0  },
  { name: "Researcher",   role: "Data Intelligence", icon: "◈", color: "#38bdf8", startSec: 3  },
  { name: "Synthesizer",  role: "Knowledge Fusion",  icon: "◎", color: "#34d399", startSec: 10 },
  { name: "Architect",    role: "System Builder",    icon: "◆", color: "#fb923c", startSec: 20 },
  { name: "Validator",    role: "Quality Gate",      icon: "◉", color: "#f472b6", startSec: 40 },
];

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
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex gap-3">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-lg shadow-indigo-500/20">
        <Sparkles size={12} className="text-white" />
      </div>
      <div className="flex-1 min-w-0 px-4 py-3 rounded-2xl rounded-tl-sm bg-white/[0.04] border border-white/[0.06] space-y-2.5">
        {/* Current active agent */}
        <div className="flex items-center gap-2.5">
          <motion.div
            animate={{ scale: [1, 1.15, 1], opacity: [0.75, 1, 0.75] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-sm flex-shrink-0"
            style={{ background: current.color + "18", border: `1px solid ${current.color}44`, color: current.color }}
          >{current.icon}</motion.div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold text-slate-200">{current.name}</span>
              <motion.span animate={{ opacity: [0, 1, 0] }} transition={{ duration: 1.2, repeat: Infinity }}
                className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded-full"
                style={{ color: current.color, background: current.color + "18" }}>ACTIVE</motion.span>
            </div>
            <p className="text-[11px] text-slate-600">{current.role}</p>
          </div>
          <span className="text-[11px] text-slate-700 flex-shrink-0 tabular-nums">{elapsed}s</span>
        </div>

        {/* Mini pipeline dots */}
        <div className="flex items-center">
          {PIPELINE_STAGES.map((stage, i) => {
            const isDone   = i < activeIdx;
            const isActive = i === activeIdx;
            return (
              <div key={stage.name} className="flex items-center flex-1">
                <motion.div
                  animate={isActive ? { scale: [1, 1.4, 1] } : {}}
                  transition={{ duration: 1.2, repeat: Infinity }}
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: (isDone || isActive) ? stage.color : "#1e293b", boxShadow: isActive ? `0 0 7px ${stage.color}` : "none" }}
                  title={stage.name}
                />
                {i < PIPELINE_STAGES.length - 1 && (
                  <div className="flex-1 h-px mx-1" style={{ background: isDone ? `linear-gradient(90deg,${stage.color}70,${PIPELINE_STAGES[i+1].color}30)` : "rgba(255,255,255,0.05)" }} />
                )}
              </div>
            );
          })}
        </div>

        {/* Stage name labels */}
        <div className="flex">
          {PIPELINE_STAGES.map((stage, i) => {
            const isActive = i === activeIdx;
            const isDone   = i < activeIdx;
            return (
              <div key={stage.name} className="flex-1 text-center">
                <span className="text-[8px] font-medium" style={{ color: isActive ? stage.color : isDone ? stage.color + "70" : "#1e293b" }}>
                  {stage.name.slice(0, 5)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

// ─── SearchLimitBadge ─────────────────────────────────────────────────────────

function SearchLimitBadge({ used, limit }: { used: number; limit: number }) {
  const pct       = limit > 0 ? (used / limit) * 100 : 0;
  const remaining = Math.max(0, limit - used);
  const cls = pct < 70
    ? { text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20", bar: "#34d399" }
    : pct < 90
    ? { text: "text-amber-400",   bg: "bg-amber-500/10",   border: "border-amber-500/20",   bar: "#fbbf24" }
    : { text: "text-red-400",     bg: "bg-red-500/10",     border: "border-red-500/20",     bar: "#f87171" };
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] ${cls.bg} ${cls.border}`}>
      <Search size={9} className={cls.text} />
      <span className="text-slate-600 hidden sm:inline">Searches:</span>
      <span className={`font-semibold tabular-nums ${cls.text}`}>{used}<span className="text-slate-700">/{limit}</span></span>
      <div className="w-12 sm:w-16 h-1 rounded-full bg-white/[0.05] overflow-hidden flex-shrink-0">
        <motion.div className="h-full rounded-full" initial={{ width: 0 }} animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8 }} style={{ background: cls.bar }} />
      </div>
      <span className="text-slate-700 hidden sm:inline">{remaining} left</span>
    </div>
  );
}

// ─── Messages ────────────────────────────────────────────────────────────────

function UserMessage({ msg }: { msg: Message }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.25 }} className="flex justify-end">
      <div className="max-w-[88%] sm:max-w-[78%] px-3 sm:px-4 py-2.5 rounded-2xl rounded-tr-sm text-white text-sm leading-relaxed" style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)", border: "1px solid rgba(99,102,241,0.3)" }}>
        {msg.content}
      </div>
    </motion.div>
  );
}

// ─── ColdStartCard ───────────────────────────────────────────────────────────

function ColdStartCard({ onRetry }: { onRetry?: () => void }) {
  const [secs, setSecs] = useState(50);
  const [fired, setFired] = useState(false);

  useEffect(() => {
    if (secs <= 0) {
      if (!fired) { setFired(true); onRetry?.(); }
      return;
    }
    const t = setTimeout(() => setSecs(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secs, fired, onRetry]);

  return (
    <div className="px-4 py-3.5 rounded-2xl rounded-tl-sm bg-amber-500/[0.07] border border-amber-500/20 space-y-3">
      <div className="flex items-start gap-2">
        <span className="text-amber-400 text-base flex-shrink-0 mt-0.5">⏳</span>
        <div className="flex-1">
          <p className="text-sm font-medium text-amber-300">Backend is waking up</p>
          <p className="text-xs text-amber-400/70 mt-0.5 leading-relaxed">
            Render free tier sleeps after inactivity. Auto-retrying in <span className="font-bold text-amber-300">{secs}s</span>…
          </p>
        </div>
      </div>
      {/* countdown bar */}
      <div className="h-1 rounded-full bg-amber-500/10 overflow-hidden">
        <motion.div className="h-full rounded-full bg-amber-400/60"
          initial={{ width: "100%" }}
          animate={{ width: `${(secs / 50) * 100}%` }}
          transition={{ duration: 0.9, ease: "linear" }} />
      </div>
      {onRetry && (
        <button onClick={() => { setFired(true); setSecs(0); onRetry(); }}
          className="text-xs text-amber-400 hover:text-amber-300 border border-amber-500/30 hover:border-amber-500/50 px-3 py-1.5 rounded-lg transition-all">
          ↺ Retry now
        </button>
      )}
    </div>
  );
}

function AssistantMessage({ msg, onRetry }: { msg: Message; onRetry?: () => void }) {
  const sources = msg.sources ?? [];
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }} className="flex gap-3">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-lg shadow-indigo-500/20">
        <Sparkles size={12} className="text-white" />
      </div>
      <div className="flex-1 min-w-0 space-y-2.5">
        {msg.isError ? (
          msg.isColdStart ? (
            <ColdStartCard onRetry={onRetry} />
          ) : (
            <div className="flex items-start gap-2 px-4 py-3 rounded-2xl rounded-tl-sm bg-red-500/[0.07] border border-red-500/20">
              <AlertCircle size={13} className="text-red-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-300/90 leading-relaxed">{msg.content}</p>
            </div>
          )
        ) : (
          <div className="px-4 py-3.5 rounded-2xl rounded-tl-sm bg-white/[0.04] border border-white/[0.06] text-sm overflow-hidden">
            <MarkdownContent content={msg.content} />
            {msg.isStreaming && <span className="inline-block w-[2px] h-[1em] bg-indigo-400 ml-0.5 animate-pulse align-text-bottom rounded-full" />}
          </div>
        )}
        {sources.length > 0 && !msg.isStreaming && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold text-slate-700 uppercase tracking-wider">Sources</p>
            <div className="grid grid-cols-1 gap-1">{sources.slice(0, 6).map((url, i) => <SourceCard key={url + i} url={url} index={i} />)}</div>
          </div>
        )}
        {msg.score !== undefined && !msg.isStreaming && (
          <div className="flex items-center gap-2"><span className="text-[10px] text-slate-700 uppercase tracking-wider font-medium">Quality</span><ScoreBadge score={msg.score} /></div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Dashboard View ───────────────────────────────────────────────────────────

function DashboardView({ statusData, onNavigate }: { statusData: StatusData | null; onNavigate: (v: View) => void }) {
  const hasData = !!statusData && statusData.total_queries > 0;

  const metrics = [
    { label: "Active Agents", value: "5",
      delta: hasData ? `${statusData!.successful_queries} completed` : "0 completed",
      icon: <Activity size={15} />, color: "#a78bfa" },
    { label: "Avg Response",
      value: hasData ? `${statusData!.avg_response_time_sec}s` : "—",
      delta: "per query", icon: <Clock size={15} />, color: "#38bdf8" },
    { label: "Success Rate",
      value: hasData ? `${statusData!.success_rate}%` : "—",
      delta: hasData ? `${statusData!.total_queries} total` : "no data yet",
      icon: <TrendingUp size={15} />, color: "#34d399" },
    { label: "Tasks Done",
      value: hasData ? String(statusData!.total_queries) : "0",
      delta: "this session", icon: <CheckCircle2 size={15} />, color: "#fb923c" },
  ];

  const agentActivity: AgentDisplayData[] = statusData?.last_run
    ? statusData.last_run.agents.map((a, i) => agentFromStatus(a, i))
    : IDLE_AGENTS;

  const recentActivity = statusData?.last_run ? [
    { text: `Pipeline completed in ${statusData.last_run.execution_time_sec}s`,           color: "#34d399" },
    { text: `Retrieved ${statusData.last_run.source_count} source${statusData.last_run.source_count !== 1 ? "s" : ""}`, color: "#38bdf8" },
    { text: `Critic scored report ${statusData.last_run.quality_score}/10`,               color: "#a78bfa" },
    { text: `Query: "${statusData.last_run.query.slice(0, 45)}${statusData.last_run.query.length > 45 ? "…" : ""}"`, color: "#fbbf24" },
  ] : [];

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8 pb-6 lg:pb-8">
      <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Command Center</h1>
          <p className="text-slate-500 text-sm mt-1">
            {hasData
              ? `${statusData!.total_queries} pipeline runs · ${statusData!.success_rate}% success rate · last run ${timeAgoISO(statusData!.last_query_at)}`
              : "Multi-agent AI research pipeline — run a query to see live data"}
          </p>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {metrics.map((m, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
              className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
              <div className="flex items-center gap-2 mb-3" style={{ color: m.color }}>{m.icon}</div>
              <div className="text-2xl font-bold text-white tracking-tight">{m.value}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{m.label}</div>
              <div className="text-[10px] mt-1.5 font-medium" style={{ color: m.color }}>{m.delta}</div>
            </motion.div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Agent activity */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}
            className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Agent Activity</p>
              <button onClick={() => onNavigate("agents")} className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors">View all →</button>
            </div>
            {!hasData ? (
              <p className="text-[11px] text-slate-700 py-4 text-center">Run a query to see real agent data</p>
            ) : (
              <div className="space-y-3">
                {agentActivity.map((a, i) => (
                  <div key={a.name} className="flex items-center gap-3">
                    <div className="text-[11px] w-[88px] flex-shrink-0 text-slate-500 truncate">{a.name}</div>
                    <div className="flex-1 h-1 rounded-full bg-white/[0.05]">
                      <motion.div className="h-full rounded-full" initial={{ width: 0 }} animate={{ width: `${Math.max(a.progress, 5)}%` }} transition={{ duration: 1.2, delay: i * 0.1 }}
                        style={{ background: `linear-gradient(90deg,${a.color}66,${a.color})` }} />
                    </div>
                    <div className="text-[11px] w-8 text-right flex-shrink-0" style={{ color: a.color }}>{a.progress}%</div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>

          {/* Recent activity */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
            className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Recent Activity</p>
              {statusData?.last_query_at && (
                <span className="text-[10px] text-slate-700">{timeAgoISO(statusData.last_query_at)}</span>
              )}
            </div>
            {recentActivity.length === 0 ? (
              <p className="text-[11px] text-slate-700 py-4 text-center">No pipeline runs yet</p>
            ) : (
              <div className="space-y-3">
                {recentActivity.map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: item.color }} />
                    <p className="text-xs text-slate-400">{item.text}</p>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        </div>

        {/* Quick actions */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}
          className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5">
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-4">Quick Actions</p>
          <div className="flex flex-wrap gap-2">
            {[
              { label: "New Chat",     action: () => onNavigate("chat")   },
              { label: "View Agents",  action: () => onNavigate("agents") },
              { label: "Run Research", action: () => onNavigate("chat")   },
              { label: "Check Agents", action: () => onNavigate("agents") },
            ].map((btn, i) => (
              <button key={i} onClick={btn.action}
                className="px-3.5 py-2 text-sm rounded-lg border border-white/[0.08] bg-white/[0.03] text-slate-400 hover:text-slate-200 hover:bg-white/[0.07] hover:border-white/[0.14] transition-all">
                {btn.label}
              </button>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// ─── Agents View ──────────────────────────────────────────────────────────────

function AgentsView({ statusData }: { statusData: StatusData | null }) {
  const [selected, setSelected] = useState<number | null>(null);
  const lastRun = statusData?.last_run ?? null;
  const agents: AgentDisplayData[] = lastRun
    ? lastRun.agents.map((a, i) => agentFromStatus(a, i))
    : IDLE_AGENTS;

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8 pb-6 lg:pb-8">
      <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Agent Pipeline</h1>
          <p className="text-slate-500 text-sm mt-1">
            {lastRun
              ? `Last run: "${lastRun.query.slice(0, 45)}${lastRun.query.length > 45 ? "…" : ""}" · ${lastRun.execution_time_sec}s · ${lastRun.source_count} source${lastRun.source_count !== 1 ? "s" : ""}`
              : "5 agents · Run a query to see real execution data"}
          </p>
        </div>

        {/* Timeline */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5">
          <p className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider mb-5">Execution Timeline</p>
          <div className="flex items-center">
            {agents.map((agent, i) => {
              const isDone   = agent.status === "done";
              const isError  = agent.status === "error";
              const isActive = agent.status === "active" || agent.status === "thinking";
              const lit      = isDone || isActive;
              return (
                <div key={agent.id} className="flex items-center flex-1">
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-7 h-7 sm:w-9 sm:h-9 rounded-full flex items-center justify-center text-xs sm:text-sm transition-all"
                      style={{ background: lit ? `${agent.color}18` : isError ? "rgba(248,113,113,0.1)" : "rgba(255,255,255,0.03)", border: `2px solid ${lit ? agent.color : isError ? "#f87171" : "#1e293b"}`, color: lit ? agent.color : isError ? "#f87171" : "#334155", boxShadow: lit ? `0 0 10px ${agent.color}40` : "none" }}>
                      {agent.icon}
                    </div>
                    <p className="text-[8px] sm:text-[9px] font-semibold text-center" style={{ color: lit ? agent.color : isError ? "#f87171" : "#334155" }}>{agent.name.slice(0, 5)}</p>
                  </div>
                  {i < agents.length - 1 && (
                    <div className="flex-1 h-px mx-2 mb-5" style={{ background: lit ? `linear-gradient(90deg,${agents[i].color}60,${agents[i + 1].color}25)` : "rgba(255,255,255,0.05)" }} />
                  )}
                </div>
              );
            })}
          </div>
        </motion.div>

        {/* Agent cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map((agent, i) => (
            <div key={agent.id} onClick={() => setSelected(selected === agent.id ? null : agent.id)}>
              <AgentCard agent={agent} index={i} />
              <AnimatePresence>
                {selected === agent.id && lastRun && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                    className="rounded-b-xl border border-t-0 border-white/[0.07] bg-white/[0.02] px-4 py-3 -mt-2 overflow-hidden">
                    <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-2">Execution Log</p>
                    {[
                      `Status: ${agent.status.toUpperCase()}`,
                      `Duration: ${agent.duration_sec ?? 0}s`,
                      `Progress: ${agent.progress}%`,
                      agent.task,
                    ].map((log, li) => (
                      <div key={li} className="text-[11px] text-slate-600 py-1 border-b border-white/[0.04] flex gap-2">
                        <span className="text-slate-700">{String(li + 1).padStart(2, "0")}</span>{log}
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

// ─── Chat View ────────────────────────────────────────────────────────────────

function ChatView({
  messages, isLoading, input, setInput, onSend, onRetry, bottomRef,
  searchesUsed, searchLimit,
}: {
  messages: Message[];
  isLoading: boolean;
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onRetry: () => void;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  searchesUsed?: number;
  searchLimit?: number;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = taRef.current; if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4 sm:px-6 text-center select-none">
            <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.35 }} className="space-y-5 sm:space-y-6 max-w-md w-full">
              <div className="space-y-2">
                <div className="w-10 h-10 sm:w-11 sm:h-11 mx-auto rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center shadow-xl shadow-indigo-500/25"><Zap size={18} className="text-white" /></div>
                <h2 className="text-xl sm:text-[22px] font-bold text-white tracking-tight">Ask anything</h2>
                <p className="text-slate-500 text-sm">Multi-agent research at your command</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {STARTER_PROMPTS.map((p, i) => (
                  <motion.button key={p} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + i * 0.06 }}
                    onClick={() => setInput(p)}
                    className="text-left px-3.5 py-3 rounded-xl border border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/[0.12] transition-all group">
                    <div className="flex items-start gap-2">
                      <Search size={11} className="text-slate-700 group-hover:text-indigo-400 transition-colors mt-0.5 flex-shrink-0" />
                      <span className="text-xs text-slate-400 group-hover:text-slate-300 leading-snug transition-colors">{p}</span>
                    </div>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-5">
            <AnimatePresence initial={false}>
              {messages.map(msg =>
                msg.role === "user"
                  ? <UserMessage key={msg.id} msg={msg} />
                  : <AssistantMessage key={msg.id} msg={msg} onRetry={msg.isColdStart ? onRetry : undefined} />
              )}
            </AnimatePresence>
            <AnimatePresence>
              {isLoading && !messages.some(m => m.isStreaming) && <LoadingAgents key="loading" />}
            </AnimatePresence>
            <div ref={bottomRef} className="h-px" />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex-shrink-0 px-3 sm:px-4 py-3 sm:py-3.5 border-t border-white/[0.05] bg-[#09090f]/90 backdrop-blur-xl">
        <div className="max-w-2xl mx-auto">
          <div className={`flex items-end gap-2.5 sm:gap-3 px-3 sm:px-4 py-2.5 rounded-2xl border transition-all duration-200 ${isLoading ? "bg-white/[0.02] border-white/[0.05]" : "bg-white/[0.04] border-white/[0.09] focus-within:border-indigo-500/50 focus-within:bg-white/[0.05] focus-within:shadow-[0_0_0_3px_rgba(99,102,241,0.07)]"}`}>
            <textarea ref={taRef} value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
              placeholder={isLoading ? "Researching…" : "Ask anything…"}
              disabled={isLoading} rows={1}
              className="flex-1 bg-transparent text-sm text-slate-200 placeholder:text-slate-600 outline-none leading-relaxed disabled:opacity-50 disabled:cursor-not-allowed min-h-[22px] max-h-[120px] sm:max-h-[160px] font-[inherit]" />
            <button onClick={onSend} disabled={isLoading || !input.trim()}
              className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-all active:scale-90 ${!isLoading && input.trim() ? "bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-500/25 hover:scale-105 active:scale-95" : "bg-white/[0.05] text-slate-700 cursor-not-allowed"}`}>
              <Send size={12} />
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5">
            <p className="text-[10px] text-slate-700 hidden sm:block">Enter to send · Shift+Enter for new line</p>
            {searchesUsed !== undefined && searchLimit !== undefined && (
              <SearchLimitBadge used={searchesUsed} limit={searchLimit} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar content ──────────────────────────────────────────────────────────

const NAV_ITEMS: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={15} /> },
  { id: "chat",      label: "Chat",      icon: <MessagesSquare  size={15} /> },
  { id: "agents",    label: "Agents",    icon: <Bot             size={15} /> },
];

function SidebarContent({
  collapsed, activeView, sessions, activeId,
  onNavigate, onNewChat, onSelectChat, onDeleteSession, onClose, showClose,
}: {
  collapsed: boolean;
  activeView: View;
  sessions: ChatSession[];
  activeId: string;
  onNavigate: (v: View) => void;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onClose: () => void;
  showClose: boolean;
}) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3.5 h-[52px] border-b border-white/[0.05] flex-shrink-0">
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center flex-shrink-0">
          <Zap size={11} className="text-white" />
        </div>
        {!collapsed && <span className="font-bold text-[14px] text-white tracking-tight flex-1">Flux AI</span>}
        {showClose && !collapsed && <button onClick={onClose} className="text-slate-600 hover:text-slate-400 transition-colors"><X size={14} /></button>}
      </div>

      {/* Nav */}
      <div className="px-2 pt-2 pb-1 flex-shrink-0">
        {NAV_ITEMS.map(item => (
          <button key={item.id} onClick={() => { onNavigate(item.id); onClose(); }}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg mb-0.5 transition-all ${activeView === item.id ? "bg-indigo-600/15 border border-indigo-500/20 text-indigo-400" : "text-slate-600 hover:text-slate-400 hover:bg-white/[0.04] border border-transparent"}`}>
            <span className="flex-shrink-0">{item.icon}</span>
            {!collapsed && <span className="text-[13px] font-medium">{item.label}</span>}
          </button>
        ))}
      </div>

      {/* New chat + recent (only in chat view) */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          <button onClick={() => { onNewChat(); onClose(); }}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-dashed border-white/[0.09] text-slate-600 hover:text-slate-400 hover:border-white/[0.18] hover:bg-white/[0.03] transition-all text-xs mb-3 mt-1">
            <Plus size={12} /><span>New chat</span>
          </button>
          {sessions.length > 0 && (
            <>
              <p className="text-[9px] font-bold text-slate-700 uppercase tracking-[0.14em] px-2 mb-1.5">Recent</p>
              {sessions.map(s => (
                <div key={s.id} className={`group relative flex items-center rounded-lg mb-0.5 transition-all ${s.id === activeId ? "bg-indigo-600/12 border border-indigo-500/18" : "border border-transparent hover:bg-white/[0.04]"}`}>
                  <button onClick={() => { onSelectChat(s.id); onClose(); }} className="flex-1 text-left px-2.5 py-2 min-w-0">
                    <div className="flex items-start gap-1.5">
                      <MessageSquare size={10} className={`mt-0.5 flex-shrink-0 ${s.id === activeId ? "text-indigo-400" : "text-slate-700"}`} />
                      <div className="min-w-0"><p className={`text-[11px] truncate leading-snug ${s.id === activeId ? "text-slate-300 font-medium" : "text-slate-600"}`}>{s.title}</p>
                        <p className="text-[9px] text-slate-700 mt-0.5">{timeAgo(s.timestamp)}</p></div>
                    </div>
                  </button>
                  <button onClick={e => { e.stopPropagation(); onDeleteSession(s.id); }}
                    className="opacity-0 group-hover:opacity-100 pr-2 text-slate-700 hover:text-red-400 transition-all flex-shrink-0">
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Footer */}
      {!collapsed && (
        <div className="px-4 py-2.5 border-t border-white/[0.04] flex-shrink-0">
          <p className="text-[10px] text-slate-700 text-center">Multi-agent AI research</p>
        </div>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [activeView, setActiveView]         = useState<View>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sessions, setSessions]             = useState<ChatSession[]>([]);
  const [activeId, setActiveId]             = useState<string>(() => uid());
  const [allMessages, setAllMessages]       = useState<Record<string, Message[]>>({});
  const [input, setInput]                   = useState("");
  const [isLoading, setIsLoading]           = useState(false);
  const [statusData, setStatusData]         = useState<StatusData | null>(null);
  const bottomRef                           = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) setStatusData(await res.json());
    } catch { /* silent */ }
  }, []);

  const messages: Message[] = allMessages[activeId] ?? [];

  // ── Storage + initial status fetch ───────────────────────────────────────
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

    // Keepalive: ping backend every 8 minutes so Render free tier stays warm
    const keepalive = setInterval(() => {
      fetch("/api/status").catch(() => {});
    }, 8 * 60 * 1000);
    return () => clearInterval(keepalive);
  }, [fetchStatus]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions, messages: allMessages })); }
    catch { /* ignore */ }
  }, [sessions, allMessages]);

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, isLoading]);

  // ── Streaming reveal ─────────────────────────────────────────────────────
  useEffect(() => {
    const s = messages.find(m => m.isStreaming && m.fullContent);
    if (!s?.fullContent) return;
    const { id, content, fullContent } = s;
    if (content.length >= fullContent.length) {
      setAllMessages(prev => ({ ...prev, [activeId]: (prev[activeId] ?? []).map(m => m.id === id ? { ...m, isStreaming: false, content: fullContent } : m) }));
      return;
    }
    const t = setTimeout(() => {
      const next = Math.min(content.length + 18, fullContent.length);
      setAllMessages(prev => ({ ...prev, [activeId]: (prev[activeId] ?? []).map(m => m.id === id ? { ...m, content: fullContent.slice(0, next) } : m) }));
    }, 14);
    return () => clearTimeout(t);
  }, [messages, activeId]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const navigate = useCallback((v: View) => { setActiveView(v); setMobileSidebarOpen(false); }, []);
  const newChat  = useCallback(() => { setActiveId(uid()); setInput(""); }, []);
  const selectChat = useCallback((id: string) => { setActiveId(id); setInput(""); setActiveView("chat"); }, []);
  const deleteSession = useCallback((id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    setAllMessages(prev => { const n = { ...prev }; delete n[id]; return n; });
    if (id === activeId) setActiveId(uid());
  }, [activeId]);
  const clearChat = useCallback(() => {
    setAllMessages(prev => ({ ...prev, [activeId]: [] }));
    setSessions(prev => prev.filter(s => s.id !== activeId));
  }, [activeId]);
  const retryLast = useCallback(() => {
    const msgs = allMessages[activeId] ?? [];
    const lastUser = [...msgs].reverse().find(m => m.role === "user");
    if (!lastUser) return;
    setAllMessages(prev => ({ ...prev, [activeId]: (prev[activeId] ?? []).filter(m => m.id !== lastUser.id && !m.isError) }));
    setInput(lastUser.content);
  }, [allMessages, activeId]);

  const sendMessage = useCallback(async () => {
    const query = input.trim();
    if (!query || isLoading) return;
    const userMsg: Message = { id: uid(), role: "user", content: query, timestamp: Date.now() };
    const aiId = uid();
    setInput(""); setIsLoading(true);
    setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] ?? []), userMsg] }));
    setSessions(prev => [{ id: activeId, title: query.length > 70 ? query.slice(0, 70) + "…" : query, timestamp: Date.now() }, ...prev.filter(s => s.id !== activeId)].slice(0, MAX_SESSIONS));
    try {
      const res  = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: query }) });
      const data: ApiResponse = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? `Request failed (${res.status})`);
      const r       = data.result ?? {};
      const report  = sanitizeReport(r.report || r.answer || "The pipeline returned no content.");
      const sources = r.sources_used ?? r.sources ?? [];
      const score   = r.critic_score;
      setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] ?? []), { id: aiId, role: "assistant", content: "", fullContent: report, sources, score, timestamp: Date.now(), isStreaming: true }] }));
      fetchStatus();
    } catch (err) {
      const text = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      const isColdStart = text.includes("cold-start") || text.includes("took too long");
      setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] ?? []), { id: aiId, role: "assistant", content: text, timestamp: Date.now(), isError: true, isColdStart }] }));
    } finally { setIsLoading(false); }
  }, [input, isLoading, activeId]);

  const activeTitle = sessions.find(s => s.id === activeId)?.title;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100dvh-56px)] lg:h-screen overflow-hidden bg-[#0a0a0f]">

      {/* ── Desktop sidebar ─────────────────────────────────────────────────── */}
      <aside className={`hidden lg:flex flex-col flex-shrink-0 border-r border-white/[0.06] bg-[#0e0e17] transition-all duration-300 ${sidebarCollapsed ? "w-[52px]" : "w-[220px]"}`}>
        <SidebarContent
          collapsed={sidebarCollapsed} activeView={activeView} sessions={sessions} activeId={activeId}
          onNavigate={navigate} onNewChat={newChat} onSelectChat={selectChat} onDeleteSession={deleteSession}
          onClose={() => {}} showClose={false}
        />
        <button onClick={() => setSidebarCollapsed(p => !p)}
          className="flex-shrink-0 flex items-center justify-center h-9 mx-2 mb-2 rounded-lg border border-white/[0.06] text-slate-700 hover:text-slate-500 hover:bg-white/[0.04] transition-all text-xs">
          {sidebarCollapsed ? <ChevronRight size={13} /> : <><ChevronLeft size={13} /><span className="ml-1 text-[10px]">Collapse</span></>}
        </button>
      </aside>

      {/* ── Mobile history drawer (chat sessions only) ──────────────────────── */}
      <AnimatePresence>
        {mobileSidebarOpen && (
          <>
            <motion.div key="ov" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setMobileSidebarOpen(false)}
              className="fixed inset-0 z-20 bg-black/60 backdrop-blur-sm lg:hidden" />
            <motion.aside key="sb" initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 280 }}
              className="fixed left-0 top-0 bottom-0 w-[260px] z-30 lg:hidden flex flex-col border-r border-white/[0.06] bg-[#0e0e17]"
              style={{ willChange: "transform" }}>
              <SidebarContent
                collapsed={false} activeView={activeView} sessions={sessions} activeId={activeId}
                onNavigate={navigate} onNewChat={newChat} onSelectChat={selectChat} onDeleteSession={deleteSession}
                onClose={() => setMobileSidebarOpen(false)} showClose={true}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ── Main column ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">

        {/* Header */}
        <header className="flex items-center gap-2 px-3 sm:px-4 h-[52px] border-b border-white/[0.05] bg-[#0a0a0f]/90 backdrop-blur-xl flex-shrink-0">
          {/* Mobile logo + hamburger (chat history) */}
          <div className="flex items-center gap-2 lg:hidden flex-1 min-w-0">
            <button onClick={() => setMobileSidebarOpen(true)}
              className="flex items-center gap-1.5 text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0">
              <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center">
                <Zap size={11} className="text-white" />
              </div>
            </button>
            <span className="text-[13px] font-bold text-white tracking-tight truncate">
              {activeView === "chat" && activeTitle ? activeTitle : "Flux AI"}
            </span>
          </div>

          {/* Desktop title */}
          <div className="hidden lg:flex flex-1 min-w-0">
            {activeView === "chat" && activeTitle
              ? <p className="text-sm text-slate-500 truncate max-w-sm">{activeTitle}</p>
              : <p className="text-sm text-slate-500 capitalize">{activeView}</p>}
          </div>

          {activeView === "chat" && messages.length > 0 && (
            <button onClick={clearChat} title="Clear chat"
              className="flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/[0.07] transition-all text-xs flex-shrink-0">
              <Trash2 size={12} /><span className="hidden sm:inline ml-0.5">Clear</span>
            </button>
          )}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ boxShadow: "0 0 6px #34d399" }} />
            <span className="text-[10px] font-semibold text-emerald-400 tracking-wide">LIVE</span>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {activeView === "dashboard" && <DashboardView statusData={statusData} onNavigate={navigate} />}
          {activeView === "agents"    && <AgentsView statusData={statusData} />}
          {activeView === "chat"      && (
            <ChatView messages={messages} isLoading={isLoading} input={input} setInput={setInput}
              onSend={sendMessage} onRetry={retryLast} bottomRef={bottomRef}
              searchesUsed={statusData?.searches_used}
              searchLimit={statusData?.search_limit} />
          )}
        </div>
      </div>

      {/* ── Mobile bottom nav bar ───────────────────────────────────────────── */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-20 border-t border-white/[0.06] bg-[#0e0e17]/95 backdrop-blur-xl flex items-stretch safe-area-inset-bottom">
        {NAV_ITEMS.map(item => (
          <button key={item.id} onClick={() => navigate(item.id)}
            className={`relative flex-1 flex flex-col items-center justify-center py-2.5 gap-1 transition-all ${activeView === item.id ? "text-indigo-400" : "text-slate-600 active:text-slate-400"}`}>
            {activeView === item.id && (
              <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-full bg-indigo-400" />
            )}
            <span className={`transition-transform duration-150 ${activeView === item.id ? "scale-110" : ""}`}>{item.icon}</span>
            <span className="text-[9px] font-semibold tracking-wide">{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
