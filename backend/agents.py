"""
agents.py — Token-optimised search agent + Gemini report writer

Optimizations vs previous version:
  - MAX_SOURCES 5 → 3
  - raw_content cap 6000 → 2500 chars per source
  - snippet cap 600 → 300 chars
  - total content sent to Gemini hard-capped at 5000 chars
  - max_output_tokens 4096 → 2048
  - prompt stripped of verbose instructions
  - 429 quota errors detected and surfaced immediately (no retry storm)
  - single Gemini call only (critic disabled in pipeline.py)
"""

import os
import re
import logging
from functools import lru_cache
from pathlib import Path
from dotenv import load_dotenv

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.output_parsers import StrOutputParser

from tools import web_search

load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=False)

logging.basicConfig(level=logging.WARNING, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

GEMINI_MODEL     = "gemini-2.0-flash"
MAX_SOURCES      = 3          # was 5 — biggest single token saving
MAX_RAW_CHARS    = 2500       # was 6000 per source
MAX_SNIPPET_CHARS = 300       # was 600
MAX_CONTENT_CHARS = 5000      # hard cap on what we send to Gemini
MAX_OUTPUT_TOKENS = 2048      # was 4096

# ─── Content cleaner ─────────────────────────────────────────────────────────

_NOISE_RE = re.compile(
    r'!\[[^\]]{0,200}\]\([^)]{0,400}\)'    # ![alt](url)
    r'|!\[[^\]]{0,200}\]\[[^\]]{0,200}\]'  # ![alt][ref]
    r'|<[a-zA-Z/][^>]{0,200}>'             # HTML tags
    r'|---\s*SOURCE:.*?---',               # --- SOURCE: url ---
    re.IGNORECASE | re.DOTALL,
)
_LINK_RE = re.compile(r'\[([^\]]{0,200})\]\([^)]{0,400}\)', re.DOTALL)
_URL_RE  = re.compile(r'https?://\S+')
_UI_RE   = re.compile(
    r'^(?:comments?|read\s+later|see\s+all|remove|share|tweet|pin\s+it|'
    r'save|print|email\s+this|follow\s+us|subscribe|sign\s+(?:in|up)|'
    r'log\s+in|newsletter|breaking\s+news|trending|most\s+read|'
    r'also\s+read|related\s+articles?|advertisement|sponsored|'
    r'photo\s+credit.*|.*\|\s*photo\s+credit.*|'
    r'\d+\s+mins?\s+read|published\s*:.*|updated\s*:.*|'
    r'home|world|india|business|sports?|health|tech|politics|science|'
    r'entertainment|magazine|defence|middle\s+east|menu|login|search)\s*$',
    re.IGNORECASE | re.MULTILINE,
)


def clean_text(text: str, max_len: int = MAX_RAW_CHARS) -> str:
    """Strip noise from Tavily content, then hard-truncate."""
    text = _NOISE_RE.sub(' ', text)
    text = _LINK_RE.sub(r'\1', text)
    text = _URL_RE.sub('', text)
    text = _UI_RE.sub('', text)
    text = re.sub(r'[ \t]{2,}', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()[:max_len]


# ─── Search agent ─────────────────────────────────────────────────────────────

@lru_cache(maxsize=32)
def _cached_search(query: str, n: int) -> dict:
    return web_search(query, max_results=n)


def search_agent(query: str, max_results: int = MAX_SOURCES) -> dict:
    logger.warning("Search: %s", query)
    result = _cached_search(query, max_results)
    logger.warning("Search done: %d results", len(result.get("results", [])))
    return result


# ─── Content builder ─────────────────────────────────────────────────────────

def build_content(search_results: dict, max_sources: int = MAX_SOURCES) -> tuple[list[str], str]:
    """
    Extract clean text from Tavily results.
    Returns (source_urls, combined_text).
    Total output is hard-capped at MAX_CONTENT_CHARS.
    """
    sources: list[str] = []
    blocks:  list[str] = []

    # Tavily's own summarised answer — usually 1-3 sentences, very token-efficient
    tavily_answer = (search_results.get("answer") or "").strip()
    if tavily_answer:
        blocks.append(f"[Summary]\n{tavily_answer[:500]}")

    for r in search_results.get("results", [])[:max_sources]:
        url     = r.get("link", "")
        title   = (r.get("title") or "").strip()
        snippet = clean_text(r.get("snippet", ""),     max_len=MAX_SNIPPET_CHARS)
        raw     = clean_text(r.get("raw_content", ""), max_len=MAX_RAW_CHARS)

        body = raw if len(raw) > len(snippet) else snippet
        body = body.strip()

        if not body or len(body.split()) < 10:
            continue

        sources.append(url)
        header = f"[{title}]" if title else "[Source]"
        blocks.append(f"{header}\n{body}")

    combined = "\n\n---\n\n".join(blocks)

    # Hard cap — this is what goes to Gemini
    if len(combined) > MAX_CONTENT_CHARS:
        combined = combined[:MAX_CONTENT_CHARS]

    logger.warning("Content: %d sources, %d chars (capped at %d)",
                   len(sources), len(combined), MAX_CONTENT_CHARS)
    return sources, combined


# ─── Report prompt (lean version) ────────────────────────────────────────────

_REPORT_PROMPT = """\
You are a research analyst. The user asked: "{query}"

Write a clear, well-structured research report using ONLY the data below.
Do NOT invent facts. Do NOT include URLs in the body.

DATA:
{data}

Format (Markdown):

# [Title about: {query}]

[2-3 sentence intro]

## Key Findings
- [specific finding]
- [specific finding]
- [specific finding]
- [add more as warranted by the data]

## Analysis
[3-4 paragraphs covering background, current state, significance, outlook.
Every claim must come from the data above.]

## Conclusion
[2-3 sentences summarising the key takeaways.]
"""


def generate_report(content: str, sources: tuple, query: str = "") -> str:
    """
    Single Gemini call → clean Markdown report.
    Handles quota errors (429) without retrying.
    """
    logger.warning("Writer: query=%r  content_len=%d", query, len(content))

    source_list = list(sources) if sources else []
    sources_md  = "\n".join(f"- {u}" for u in source_list[:MAX_SOURCES]) or "No sources."

    def _wrap(body: str) -> str:
        return f"{body.rstrip()}\n\n## Sources\n\n{sources_md}"

    if not content or not content.strip():
        return _wrap(
            f"# Research Report: {query}\n\n"
            "Insufficient data was retrieved. Please try rephrasing your question."
        )

    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        logger.error("GOOGLE_API_KEY not set")
        return _wrap(
            f"# Research Report: {query}\n\n"
            "Configuration error: API key missing. Contact the administrator."
        )

    # Hard-cap the data going into the prompt
    data_for_prompt = content[:MAX_CONTENT_CHARS]

    prompt = _REPORT_PROMPT.format(
        query=query or "the topic",
        data=data_for_prompt,
    )

    try:
        llm = ChatGoogleGenerativeAI(
            model=GEMINI_MODEL,
            google_api_key=api_key,
            temperature=0.3,
            max_output_tokens=MAX_OUTPUT_TOKENS,
        )

        report = (llm | StrOutputParser()).invoke(prompt)
        report = (report or "").strip()

        if not report:
            raise RuntimeError("LLM returned empty response")

        # Light cleanup
        report = _UI_RE.sub('', report)
        report = re.sub(r'\n{3,}', '\n\n', report).strip()

        logger.warning("Writer done: %d chars", len(report))
        return _wrap(report)

    except Exception as exc:
        exc_str = str(exc)
        logger.error("Writer error (%s): %s", type(exc).__name__, exc_str)

        # ── Quota / rate-limit errors — surface immediately, don't retry ──
        if _is_quota_error(exc_str):
            return _wrap(
                f"# Quota Limit Reached\n\n"
                "The AI service has hit its free-tier quota limit for today.\n\n"
                "**What to do:**\n"
                "- Wait a few minutes and try again\n"
                "- The quota resets every minute for rate limits, daily for quota limits\n"
                "- Try a shorter or simpler query to reduce token usage"
            )

        # Other errors — show cleaned source data as fallback
        safe = clean_text(content, max_len=1000)
        return _wrap(
            f"# Research Report: {query}\n\n"
            f"{safe}\n\n"
            "*Note: Report generation encountered an issue. Showing source data.*"
        )


def _is_quota_error(msg: str) -> bool:
    """Detect Gemini 429 / quota-exhausted errors."""
    msg_lower = msg.lower()
    return any(kw in msg_lower for kw in (
        "429", "resourceexhausted", "resource_exhausted",
        "quota", "rate limit", "ratelimit", "too many requests",
        "quota exceeded", "quotaexceeded",
    ))
