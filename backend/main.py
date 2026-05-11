# ============================================================
# main.py — FastAPI entry point
#
# IMPORT ORDER IS CRITICAL:
#   1. stdlib
#   2. dotenv load  ← must happen before any local module import
#   3. third-party (fastapi, pydantic, …)
#   4. local modules (pipeline, agents, tools)
# ============================================================

import os
import logging
import time as _time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

_ENV_PATH = Path(__file__).parent / ".env"
_LOADED   = load_dotenv(dotenv_path=_ENV_PATH, override=False)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
_log = logging.getLogger("main")
_log.info(".env path    : %s", _ENV_PATH)
_log.info(".env exists  : %s", _ENV_PATH.exists())
_log.info(".env loaded  : %s", _LOADED)
_log.info("TAVILY_API_KEY  present : %s", bool(os.getenv("TAVILY_API_KEY")))
_log.info("GOOGLE_API_KEY  present : %s", bool(os.getenv("GOOGLE_API_KEY")))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from pipeline import run_research_pipeline  # noqa: E402

app = FastAPI(title="GENAI Research API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── In-memory stats (resets on server restart) ───────────────────────────────

# Tavily free plan: 1000 API credits/month. Each /chat = 1 search credit.
TAVILY_SEARCH_LIMIT = 1000

_stats: dict = {
    "total_queries":      0,
    "successful_queries": 0,
    "failed_queries":     0,
    "response_times":     deque(maxlen=100),  # rolling window of last 100 runs
    "last_query_at":      None,               # ISO-8601 string
    "last_run":           None,               # dict — see /status schema
}

# Stage → (display name, role) mapping  [reader stage removed]
_STAGE_AGENT = {
    "search": ("Researcher",  "Data Intelligence"),
    "scrape": ("Synthesizer", "Knowledge Fusion"),
    "writer": ("Architect",   "System Builder"),
    "critic": ("Validator",   "Quality Gate"),
}

_AGENT_DESC = {
    "Researcher":  "Searched and retrieved web sources",
    "Synthesizer": "Extracted and cleaned source content",
    "Architect":   "Generated detailed research report",
    "Validator":   "Reviewed report quality and accuracy",
}


def _build_step_tracker():
    """Returns (callback, timings_dict). callback(step, status) records per-stage timing."""
    timings: dict = {}

    def on_step(step: str, status: str) -> None:
        now = _time.time()
        if status == "running":
            timings[step] = {"start": now, "status": "running"}
        else:
            entry = timings.get(step, {"start": now})
            entry["end"] = now
            entry["duration"] = round(now - entry.get("start", now), 2)
            entry["status"] = status
            timings[step] = entry

    return on_step, timings


def _build_agent_list(timings: dict, total_elapsed: float) -> list:
    """Convert per-stage timings into the agent list returned by /status."""
    agents = [{
        "name":        "Orchestrator",
        "role":        "Master Controller",
        "status":      "done",
        "duration_sec": total_elapsed,
        "progress":    100,
        "description": f"Coordinated full pipeline in {total_elapsed}s",
    }]

    seen: set = set()
    for stage in ["search", "scrape", "writer", "critic"]:
        if stage not in timings:
            continue
        name, role = _STAGE_AGENT[stage]
        t   = timings[stage]
        dur = t.get("duration", 0)
        st  = t.get("status", "done")

        if name in seen:
            # Merge scrape + reader into a single Synthesizer entry
            for a in agents:
                if a["name"] == name:
                    a["duration_sec"] = round(a["duration_sec"] + dur, 2)
                    if st == "error":
                        a["status"] = "error"
                    break
            continue

        seen.add(name)
        agents.append({
            "name":        name,
            "role":        role,
            "status":      st,
            "duration_sec": round(dur, 2),
            "progress":    100 if st == "done" else 0,
            "description": _AGENT_DESC.get(name, ""),
        })

    return agents


# ─── Routes ───────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str


@app.get("/")
async def root():
    return {"status": "Backend Running"}


@app.get("/status")
async def status():
    total  = _stats["total_queries"]
    success = _stats["successful_queries"]
    times  = list(_stats["response_times"])
    return {
        "total_queries":         total,
        "successful_queries":    success,
        "failed_queries":        _stats["failed_queries"],
        "success_rate":          round(success / total * 100, 1) if total > 0 else 0.0,
        "avg_response_time_sec": round(sum(times) / len(times), 1) if times else 0.0,
        "last_query_at":         _stats["last_query_at"],
        "last_run":              _stats["last_run"],
        # Search credit tracking (each pipeline run = 1 Tavily call)
        "searches_used":         total,
        "search_limit":          TAVILY_SEARCH_LIMIT,
        "searches_remaining":    max(0, TAVILY_SEARCH_LIMIT - total),
    }


@app.post("/chat")
async def chat(req: ChatRequest):
    on_step, timings = _build_step_tracker()
    pipeline_start   = _time.time()

    _stats["total_queries"] += 1
    _stats["last_query_at"]  = datetime.now(timezone.utc).isoformat()

    try:
        result = run_research_pipeline(req.message, step_callback=on_step)
        elapsed = round(_time.time() - pipeline_start, 2)

        is_error = bool(result.get("error") and not result.get("sources"))
        if is_error:
            _stats["failed_queries"] += 1
        else:
            _stats["successful_queries"] += 1

        _stats["response_times"].append(elapsed)
        _stats["last_run"] = {
            "query":              req.message,
            "execution_time_sec": elapsed,
            "source_count":       len(result.get("sources", [])),
            "quality_score":      result.get("review", {}).get("score", 0),
            "agents":             _build_agent_list(timings, elapsed),
        }

        return {"success": True, "result": result}

    except Exception as exc:
        _stats["failed_queries"] += 1
        _log.exception("Pipeline error for query=%r", req.message)
        raise HTTPException(status_code=500, detail=str(exc))
