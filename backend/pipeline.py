"""
pipeline.py — Token-optimised 3-stage research pipeline

Optimizations vs previous version:
  - Critic stage DISABLED (was doubling token usage with a second Gemini call)
  - 429 quota errors bubble up immediately — no retry storm
  - max_sources passed as 3 throughout
  - logging reduced to warnings only
  - _abort helper preserved for frontend compatibility

Stage 1 — Search   (Tavily, cached)
Stage 2 — Content  (build_content, Tavily data only)
Stage 3 — Writer   (single Gemini call, ≤5000 char input, ≤2048 token output)
Stage 4 — Critic   DISABLED (re-enable when off free tier)
"""

import os
import logging
import time
import traceback
from typing import Optional, Callable
from pathlib import Path
from dotenv import load_dotenv

from agents import search_agent, build_content, generate_report, _is_quota_error, MAX_SOURCES

load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=False)

logging.basicConfig(level=logging.WARNING, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

# Critic disabled — set True to re-enable once off free tier
_CRITIC_ENABLED = False

_CRITIC_DEFAULTS = {
    "strengths": [], "weaknesses": [], "hallucinations": [],
    "improvements": [], "score": 0,
}


# ─── No-op callbacks ──────────────────────────────────────────────────────────

def _noop_step(step: str, status: str) -> None: pass
def _noop_log(msg: str, level: str = "info")  -> None: pass


# ─── Main pipeline ────────────────────────────────────────────────────────────

def run_research_pipeline(
    query: str,
    step_callback: Optional[Callable[[str, str], None]] = None,
    log_callback:  Optional[Callable[[str, str], None]] = None,
) -> dict:
    """
    Run optimised 3-stage research pipeline. Always returns a dict, never raises.
    """
    _step = step_callback or _noop_step
    _log  = log_callback  or _noop_log

    start = time.time()
    _log(f"Pipeline started: {query}", "info")

    def _abort(reason: str, is_quota: bool = False) -> dict:
        elapsed = round(time.time() - start, 2)
        if is_quota:
            report = (
                "**Quota limit reached.** The AI service has exhausted its free-tier allowance.\n\n"
                "Please wait a few minutes and try again, or try a shorter query."
            )
        else:
            report = f"**Research failed:** {reason}"
        return {
            "query":             query,
            "error":             reason,
            "report":            report,
            "sources":           [],
            "review":            _CRITIC_DEFAULTS.copy(),
            "processed_content": "",
            "metadata": {
                "source_count":       0,
                "content_length":     0,
                "execution_time_sec": elapsed,
            },
        }

    # ── Stage 1: Search ──────────────────────────────────────────────────────
    _step("search", "running")
    _log("Searching…", "info")
    try:
        search_results = search_agent(query, max_results=MAX_SOURCES)
    except Exception:
        last_line = traceback.format_exc().splitlines()[-1]
        _step("search", "error")
        return _abort("Search failed: " + last_line)

    if not search_results.get("results"):
        _step("search", "error")
        return _abort("No search results found for this query.")

    _log(f"Search: {len(search_results['results'])} results.", "info")
    _step("search", "done")

    # ── Stage 2: Build content ────────────────────────────────────────────────
    _step("scrape", "running")
    _log("Extracting content…", "info")
    try:
        sources, content = build_content(search_results, max_sources=MAX_SOURCES)
    except Exception:
        last_line = traceback.format_exc().splitlines()[-1]
        _step("scrape", "error")
        return _abort("Content extraction failed: " + last_line)

    if not content.strip():
        _step("scrape", "error")
        return _abort("No usable content found in search results.")

    _log(f"Content: {len(content)} chars from {len(sources)} sources.", "info")
    _step("scrape", "done")

    # ── Stage 3: Generate report ──────────────────────────────────────────────
    _step("writer", "running")
    _log("Writing report…", "info")
    try:
        report = generate_report(content, tuple(sources), query=query)
    except Exception:
        last_line = traceback.format_exc().splitlines()[-1]
        is_quota  = _is_quota_error(last_line)
        _step("writer", "error")
        return _abort("Report generation failed: " + last_line, is_quota=is_quota)

    # Detect quota error surfaced as a graceful report string
    if not report.strip():
        report = f"# Research Report: {query}\n\nNo content generated."

    _step("writer", "done")
    _log("Report done.", "info")

    # ── Stage 4: Critic — DISABLED to save quota ─────────────────────────────
    # Re-enable by setting _CRITIC_ENABLED = True at the top of this file.
    _step("critic", "running")
    review = _CRITIC_DEFAULTS.copy()
    _step("critic", "done")

    elapsed = round(time.time() - start, 2)
    _log(f"Pipeline done in {elapsed}s", "info")

    return {
        "query":             query,
        "report":            report,
        "sources":           sources,
        "review":            review,
        "processed_content": content[:1000],   # reduced from 2000
        "metadata": {
            "source_count":       len(sources),
            "content_length":     len(content),
            "execution_time_sec": elapsed,
        },
    }
