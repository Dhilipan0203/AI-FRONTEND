"""
agents.py — Search agent + direct Gemini report writer

Architecture (simplified):
  search_agent()    — Tavily search with relevance-ranked results
  build_content()   — extract clean text from Tavily results (no HTTP scraping)
  generate_report() — single direct Gemini API call → clean Markdown report
"""

import os
import re
import json
import logging
from functools import lru_cache
from pathlib import Path
from dotenv import load_dotenv

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.output_parsers import StrOutputParser

from tools import web_search

# Load .env with explicit path so it works regardless of working directory
load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=False)

logging.basicConfig(level=logging.WARNING, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

GEMINI_MODEL = "gemini-2.0-flash"

# ─── Content cleaner ─────────────────────────────────────────────────────────

# Remove markdown images, HTML tags, source separators
_NOISE_RE = re.compile(
    r'!\[[^\]]{0,300}\]\([^)]{0,600}\)'   # ![alt](url)
    r'|!\[[^\]]{0,300}\]\[[^\]]{0,300}\]' # ![alt][ref]
    r'|<[a-zA-Z/][^>]{0,300}>'            # HTML tags
    r'|---\s*SOURCE:.*?---',               # --- SOURCE: url ---
    re.IGNORECASE | re.DOTALL,
)

# Remove ALL inline markdown links [text](url) — keep text
_LINK_RE = re.compile(r'\[([^\]]{0,300})\]\([^)]{0,600}\)', re.DOTALL)

# Remove bare URLs
_URL_RE = re.compile(r'https?://\S+')

# Website UI boilerplate lines
_UI_RE = re.compile(
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


def clean_text(text: str, max_len: int = 8000) -> str:
    """Strip all garbage from scraped/Tavily text."""
    text = _NOISE_RE.sub(' ', text)
    text = _LINK_RE.sub(r'\1', text)    # keep link text, drop URL
    text = _URL_RE.sub('', text)
    text = _UI_RE.sub('', text)
    text = re.sub(r'[ \t]{2,}', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()[:max_len]


# ─── Search agent ─────────────────────────────────────────────────────────────

@lru_cache(maxsize=32)
def _cached_search(query: str, n: int) -> dict:
    return web_search(query, max_results=n)


def search_agent(query: str, max_results: int = 5) -> dict:
    logger.warning("Search: %s", query)
    # Use the query as-is — no suffix that might skew results
    result = _cached_search(query, max_results)
    logger.warning("Search done: %d results", len(result.get("results", [])))
    return result


# ─── Content builder (Tavily data only — no HTTP scraping) ───────────────────

def build_content(search_results: dict, max_sources: int = 5) -> tuple[list[str], str]:
    """
    Extract clean content from Tavily search results.
    Returns (source_urls, combined_text).
    """
    sources   : list[str] = []
    blocks    : list[str] = []

    tavily_answer = search_results.get("answer", "").strip()
    if tavily_answer:
        blocks.append(f"[Search Summary]\n{tavily_answer}")

    for r in search_results.get("results", [])[:max_sources]:
        url     = r.get("link", "")
        title   = r.get("title", "").strip()
        snippet = clean_text(r.get("snippet", ""), max_len=600)
        raw     = clean_text(r.get("raw_content", ""), max_len=6000)

        # Choose the richer content
        body = raw if len(raw) > len(snippet) else snippet
        body = body.strip()

        if not body or len(body.split()) < 15:
            continue

        sources.append(url)
        header = f"[Source: {title}]" if title else "[Source]"
        blocks.append(f"{header}\n{body}")

    combined = "\n\n---\n\n".join(blocks)
    logger.warning("Content built: %d sources, %d chars", len(sources), len(combined))
    return sources, combined


# ─── Direct Gemini report writer ─────────────────────────────────────────────

_REPORT_PROMPT = """\
You are an expert research analyst. The user asked: "{query}"

Your job: write a comprehensive, detailed, well-structured research report \
that fully answers the question above.

Use ONLY the research data provided below. Do NOT use outside knowledge.

RESEARCH DATA:
{data}

STRICT OUTPUT RULES:
- Write in clean, fluent English prose
- Do NOT include navigation menus, button labels, cookie notices, UI text
- Do NOT include raw URLs in the body text
- Do NOT hallucinate facts, statistics, or quotes not in the data
- Be thorough — cover every relevant angle found in the data
- If data is limited for a section, say so honestly

Write the complete report now in clean Markdown:

# [Specific descriptive title directly about: {query}]

[3-5 sentence introduction that sets context and states what this report covers]

## Key Findings

- [Detailed, specific finding from the data — not vague]
- [Detailed, specific finding from the data]
- [Detailed, specific finding from the data]
- [Keep adding findings for everything meaningful in the data — aim for 6-8 points]

## Detailed Analysis

[Write 4-6 substantial paragraphs. Each paragraph should explore a different aspect: \
background, current situation, key events, significance, controversies if any, \
impact, and future outlook. Every claim must come from the research data.]

## Conclusion

[3-4 sentences summarising the most important takeaways and their significance.]
"""


def generate_report(content: str, sources: tuple, query: str = "") -> str:
    """
    Call Gemini directly (no LangChain) to write a detailed Markdown report.
    Returns a clean markdown string.
    """
    logger.warning("Writer started for query: %s", query)

    source_list = list(sources) if sources else []
    sources_md  = "\n".join(f"- {u}" for u in source_list[:5]) or "No sources."

    def _wrap(body: str) -> str:
        return f"{body.rstrip()}\n\n## Sources\n\n{sources_md}"

    if not content or not content.strip():
        return _wrap(
            f"# Research Report: {query}\n\n"
            "Insufficient data was retrieved. Please try rephrasing your question."
        )

    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        logger.error("GOOGLE_API_KEY is not set in environment")
        return _wrap(
            f"# Research Report: {query}\n\n"
            "Server configuration error: API key is missing. "
            "Please contact the administrator."
        )

    try:
        llm = ChatGoogleGenerativeAI(
            model=GEMINI_MODEL,
            google_api_key=api_key,
            temperature=0.35,
            max_output_tokens=4096,
        )

        # Build prompt as a plain string — no PromptTemplate, no double-variable issues
        prompt = _REPORT_PROMPT.format(
            query=query or "the topic",
            data=content[:9000],
        )

        report = (llm | StrOutputParser()).invoke(prompt)
        report = (report or "").strip()
        if not report:
            raise RuntimeError("LLM returned empty response")

        # Safety pass — remove any UI noise Gemini echoed
        report = _UI_RE.sub('', report)
        report = re.sub(r'\n{3,}', '\n\n', report).strip()

        logger.warning("Writer done — %d chars", len(report))
        return _wrap(report)

    except Exception as exc:
        logger.error("Writer error (%s): %s", type(exc).__name__, exc)
        # Fallback: show the cleaned research data directly
        safe = clean_text(content, max_len=1500)
        return _wrap(
            f"# Research Report: {query}\n\n"
            f"{safe}\n\n"
            "*Note: Full report generation encountered an issue. "
            "Showing extracted research data.*"
        )
