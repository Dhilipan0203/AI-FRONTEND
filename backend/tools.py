"""
tools.py — web search + scraping utilities (Tavily backend)
"""

import os
import json
import time
import logging
from pathlib import Path
from functools import lru_cache

import requests
from bs4 import BeautifulSoup
from tavily import TavilyClient
from urllib.parse import urlparse
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from dotenv import load_dotenv

_ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH, override=False)

logging.basicConfig(level=logging.WARNING, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

REQUEST_TIMEOUT      = 10
MIN_PARAGRAPH_LENGTH = 40

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

_tavily_client: TavilyClient | None = None


def _get_tavily_client() -> TavilyClient:
    global _tavily_client
    if _tavily_client is None:
        api_key = os.getenv("TAVILY_API_KEY")
        if not api_key:
            raise RuntimeError("TAVILY_API_KEY is not set.")
        _tavily_client = TavilyClient(api_key=api_key)
    return _tavily_client


session = requests.Session()
_retry  = Retry(total=2, backoff_factor=0.5, status_forcelist=[429, 500, 502, 503, 504])
_adp    = HTTPAdapter(pool_connections=10, pool_maxsize=10, max_retries=_retry)
session.mount("http://",  _adp)
session.mount("https://", _adp)


def is_valid_url(url: str) -> bool:
    try:
        p = urlparse(url)
        return p.scheme in ("http", "https") and p.hostname not in ("localhost", "127.0.0.1")
    except Exception:
        return False


@lru_cache(maxsize=64)
def web_search(query: str, max_results: int = 5) -> dict:
    logger.warning("Searching: %s", query)
    try:
        client   = _get_tavily_client()
        response = client.search(
            query=query,
            search_depth="advanced",
            max_results=max_results,
            include_raw_content=True,   # full page text from Tavily
            include_answer=True,        # Tavily's own summarised answer
        )

        results_list = []
        for r in response.get("results", []):
            link = r.get("url", "")
            if not link:
                continue
            results_list.append({
                "title":       r.get("title", ""),
                "link":        link,
                "snippet":     (r.get("content") or "")[:300],        # trimmed excerpt
                "raw_content": (r.get("raw_content") or "")[:3000],   # capped (agents.py trims further)
                "score":       r.get("score", 0),
            })

        # Sort by relevance score descending
        results_list.sort(key=lambda x: x["score"], reverse=True)

        logger.warning("Search done: %d results", len(results_list))
        return {
            "status":  "success",
            "query":   query,
            "answer":  response.get("answer", ""),   # Tavily's own answer
            "results": results_list,
        }

    except Exception as exc:
        logger.error("Search failed: %s", exc)
        return {"status": "error", "message": str(exc), "results": []}


def clean_html(soup: BeautifulSoup) -> BeautifulSoup:
    for tag in soup(["script", "style", "nav", "footer", "header",
                     "aside", "form", "noscript", "svg", "iframe"]):
        tag.decompose()
    return soup


def extract_content(soup: BeautifulSoup) -> str:
    body = (
        soup.find("article")
        or soup.find("main")
        or soup.find("div", {"id": "content"})
        or soup.find("div", {"class": "content"})
        or soup.body
    )
    paragraphs = body.find_all("p") if body else soup.find_all("p")
    parts = []
    for p in paragraphs:
        text = p.get_text(separator=" ", strip=True)
        if len(text) >= MIN_PARAGRAPH_LENGTH:
            parts.append(text)
    return " ".join(parts)[:5000]


@lru_cache(maxsize=64)
def scrape_url(url: str) -> dict:
    if not is_valid_url(url):
        return {"status": "error", "message": "Invalid URL", "url": url}
    try:
        resp = session.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        if resp.status_code != 200:
            return {"status": "error", "message": f"HTTP {resp.status_code}", "url": url}
        if "text/html" not in resp.headers.get("Content-Type", ""):
            return {"status": "error", "message": "Non-HTML", "url": url}
        soup    = clean_html(BeautifulSoup(resp.text, "html.parser"))
        content = extract_content(soup)
        if not content.strip():
            return {"status": "error", "message": "No content", "url": url}
        return {"status": "success", "url": url, "content": content}
    except Exception as exc:
        return {"status": "error", "message": str(exc), "url": url}


if __name__ == "__main__":
    res = web_search("Latest AI trends 2026")
    print(json.dumps(res, indent=2))
