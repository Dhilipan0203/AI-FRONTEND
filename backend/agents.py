"""
agents.py — Search agent + Groq report writer

Architecture:
  search_agent()    — Tavily search (cached, 3 sources max)
  build_content()   — extract clean text from Tavily results
  generate_report() — single Groq call → clean Markdown report

Token optimizations (preserved):
  - MAX_SOURCES = 3
  - raw_content cap 2500 chars/source
  - total content hard-capped at 5000 chars before LLM call
  - max_tokens = 2048
  - lean prompt
  - rate-limit errors surfaced immediately, no retry storm
"""

import os
import re
import logging
from functools import lru_cache
from pathlib import Path
from dotenv import load_dotenv

from langchain_groq import ChatGroq
from langchain_core.output_parsers import StrOutputParser

from tools import web_search

load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=False)

logging.basicConfig(level=logging.WARNING, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

GROQ_MODEL        = "llama-3.1-8b-instant"
MAX_SOURCES       = 3
MAX_RAW_CHARS     = 2500
MAX_SNIPPET_CHARS = 300
MAX_CONTENT_CHARS = 5000
MAX_OUTPUT_TOKENS = 2048

# ─── Content cleaner ─────────────────────────────────────────────────────────

_NOISE_RE = re.compile(
    r'!\[[^\]]{0,200}\]\([^)]{0,400}\)'
    r'|!\[[^\]]{0,200}\]\[[^\]]{0,200}\]'
    r'|<[a-zA-Z/][^>]{0,200}>'
    r'|---\s*SOURCE:.*?---',
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
    Returns (source_urls, combined_text) — total capped at MAX_CONTENT_CHARS.
    """
    sources: list[str] = []
    blocks:  list[str] = []

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

    if len(combined) > MAX_CONTENT_CHARS:
        combined = combined[:MAX_CONTENT_CHARS]

    logger.warning("Content: %d sources, %d chars", len(sources), len(combined))
    return sources, combined


# ─── Report prompt ────────────────────────────────────────────────────────────

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


# ─── Groq report writer ───────────────────────────────────────────────────────

def generate_report(content: str, sources: tuple, query: str = "") -> str:
    """
    Single Groq call → clean Markdown report.
    Rate-limit errors (429) are surfaced immediately without retrying.
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

    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        logger.error("GROQ_API_KEY not set")
        return _wrap(
            f"# Research Report: {query}\n\n"
            "Configuration error: GROQ_API_KEY is missing. Contact the administrator."
        )

    prompt = _REPORT_PROMPT.format(
        query=query or "the topic",
        data=content[:MAX_CONTENT_CHARS],
    )

    try:
        llm = ChatGroq(
            model=GROQ_MODEL,
            groq_api_key=api_key,
            temperature=0.2,
            max_tokens=MAX_OUTPUT_TOKENS,
            max_retries=1,
        )

        report = (llm | StrOutputParser()).invoke(prompt)
        report = (report or "").strip()

        if not report:
            raise RuntimeError("LLM returned empty response")

        report = _UI_RE.sub('', report)
        report = re.sub(r'\n{3,}', '\n\n', report).strip()

        logger.warning("Writer done: %d chars", len(report))
        return _wrap(report)

    except Exception as exc:
        exc_str = str(exc)
        logger.error("Writer error (%s): %s", type(exc).__name__, exc_str)

        if _is_rate_limit_error(exc_str):
            return _wrap(
                "# Rate Limit Reached\n\n"
                "The AI service is currently rate-limited.\n\n"
                "**What to do:**\n"
                "- Wait 30–60 seconds and try again\n"
                "- Groq free tier resets quickly (per-minute limits)\n"
                "- Try a shorter or simpler query"
            )

        safe = clean_text(content, max_len=1000)
        return _wrap(
            f"# Research Report: {query}\n\n"
            f"{safe}\n\n"
            "*Note: Report generation encountered an issue. Showing source data.*"
        )


def _is_rate_limit_error(msg: str) -> bool:
    """Detect Groq 429 / rate-limit errors."""
    msg_lower = msg.lower()
    return any(kw in msg_lower for kw in (
        "429", "rate_limit", "rate limit", "ratelimit",
        "too many requests", "quota", "quota exceeded",
        "resource_exhausted", "resourceexhausted",
        "tokens per minute", "requests per minute",
    ))
