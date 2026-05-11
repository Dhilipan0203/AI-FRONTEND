"""
pipeline.py — Simplified 3-stage research pipeline

Stage 1 — Search   (Tavily)
Stage 2 — Writer   (direct Gemini call via agents.generate_report)
Stage 3 — Critic   (Gemini, non-fatal)

Removed stages (were causing garbage output):
  × HTTP scraping  — got nav menus, cookie notices, paywalls
  × Reader/chunking — added failure points with no benefit

Content flow:
  Tavily results (title + snippet + raw_content)
    → build_content()  (clean, combine)
    → generate_report() (single Gemini call → Markdown)
"""

import os
import re
import json
import logging
import time
import traceback
from typing import Optional, Callable

from pathlib import Path
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.output_parsers import StrOutputParser

from agents import search_agent, build_content, generate_report

load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=False)

logging.basicConfig(level=logging.WARNING, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

GEMINI_MODEL = "gemini-2.0-flash"

# ─── Critic ───────────────────────────────────────────────────────────────────

_CRITIC_PROMPT = """\
You are a strict research quality reviewer.

Evaluate the report below against the source data provided.

SOURCE DATA (excerpt):
{source}

REPORT:
{report}

Return ONLY valid JSON (no markdown, no extra text):
{{
    "strengths":      ["<strength>"],
    "weaknesses":     ["<weakness>"],
    "hallucinations": ["<hallucinated claim, if any>"],
    "improvements":   ["<suggestion>"],
    "score": <integer 1-10>
}}
"""

_CRITIC_DEFAULTS = {
    "strengths": [], "weaknesses": [], "hallucinations": [],
    "improvements": [], "score": 0,
}


def _parse_json(text: str, defaults: dict) -> dict:
    for pat in [r"```(?:json)?\s*([\s\S]*?)```", None]:
        try:
            chunk = re.search(pat, text, re.IGNORECASE).group(1).strip() if pat else text
            start, end = chunk.find("{"), chunk.rfind("}")
            if start != -1 and end > start:
                return json.loads(chunk[start:end + 1])
        except Exception:
            pass
    return defaults


def _run_critic(report: str, source_content: str) -> dict:
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return _CRITIC_DEFAULTS.copy()
    try:
        llm    = ChatGoogleGenerativeAI(model=GEMINI_MODEL, google_api_key=api_key,
                                        temperature=0.1, max_output_tokens=1024)
        prompt = _CRITIC_PROMPT.format(
            source=source_content[:4000],
            report=report[:4000],
        )
        text = (llm | StrOutputParser()).invoke(prompt)
        return _parse_json(text or "", _CRITIC_DEFAULTS.copy())
    except Exception as exc:
        logger.warning("Critic failed (non-fatal): %s", exc)
        return _CRITIC_DEFAULTS.copy()


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
    Run 3-stage research pipeline. Always returns a dict, never raises.
    """
    _step = step_callback or _noop_step
    _log  = log_callback  or _noop_log

    start = time.time()
    _log(f"Pipeline started: {query}", "info")

    def _abort(reason: str) -> dict:
        elapsed = round(time.time() - start, 2)
        return {
            "query":             query,
            "error":             reason,
            "report":            f"**Research failed:** {reason}",
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
        search_results = search_agent(query)
    except Exception:
        _step("search", "error")
        return _abort("Search failed: " + traceback.format_exc().splitlines()[-1])

    if not search_results.get("results"):
        _step("search", "error")
        return _abort("No search results found for this query.")

    _log(f"Search returned {len(search_results['results'])} results.", "info")
    _step("search", "done")

    # ── Stage 2: Build content from Tavily data ───────────────────────────────
    _step("scrape", "running")
    _log("Extracting content from search results…", "info")
    try:
        sources, content = build_content(search_results, max_sources=5)
    except Exception:
        _step("scrape", "error")
        return _abort("Content extraction failed: " + traceback.format_exc().splitlines()[-1])

    if not content.strip():
        _step("scrape", "error")
        return _abort("No usable content found in search results.")

    _log(f"Content ready: {len(content)} chars from {len(sources)} sources.", "info")
    _step("scrape", "done")

    # ── Stage 3: Generate report (single Gemini call) ─────────────────────────
    _step("writer", "running")
    _log("Writing report…", "info")
    try:
        report = generate_report(content, tuple(sources), query=query)
    except Exception:
        _step("writer", "error")
        return _abort("Report generation failed: " + traceback.format_exc().splitlines()[-1])

    if not report.strip():
        report = f"# Research Report: {query}\n\nNo content generated."

    _step("writer", "done")
    _log("Report generated.", "info")

    # ── Stage 4: Critic (non-fatal) ───────────────────────────────────────────
    _step("critic", "running")
    review = _run_critic(report, content[:4000])
    _step("critic", "done" if review.get("score", 0) > 0 else "error")
    _log(f"Critic score: {review.get('score', 0)}/10", "info")

    elapsed = round(time.time() - start, 2)
    _log(f"Pipeline done in {elapsed}s", "info")

    return {
        "query":             query,
        "report":            report,
        "sources":           sources,
        "review":            review,
        "processed_content": content[:2000],
        "metadata": {
            "source_count":       len(sources),
            "content_length":     len(content),
            "execution_time_sec": elapsed,
        },
    }
