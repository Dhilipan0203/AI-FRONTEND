/**
 * app/api/chat/route.ts — proxies POST /api/chat → FastAPI backend.
 *
 * Vercel plan limits:
 *   Hobby : 60 s max function duration
 *   Pro   : 300 s max function duration
 *
 * We set maxDuration = 60 (Hobby-safe).  The AbortController fires at 55 s
 * so we always return a clean JSON error before Vercel hard-kills the function.
 */

import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

// 60 s = Vercel Hobby plan maximum. Upgrade to Pro for 300 s.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { message?: string };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON in request body." },
      { status: 400 }
    );
  }

  const message = (body.message ?? "").trim();
  if (!message) {
    return NextResponse.json(
      { success: false, error: "message field is required and cannot be empty." },
      { status: 400 }
    );
  }

  // Fire 5 s before Vercel's hard limit so we can return a proper JSON error.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);

  try {
    const upstream = await fetch(`${BACKEND_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json(
        { success: false, error: `Backend returned ${upstream.status}: ${text.slice(0, 200)}` },
        { status: upstream.status }
      );
    }

    const data = await upstream.json();
    return NextResponse.json(data);

  } catch (err) {
    clearTimeout(timeout);

    if (err instanceof Error && err.name === "AbortError") {
      return NextResponse.json(
        {
          success: false,
          error:
            "The research pipeline took too long (> 55 s). " +
            "This usually means the backend is cold-starting on Render's free tier. " +
            "Please wait 30 seconds and try again — it will be faster once warm.",
        },
        { status: 504 }
      );
    }

    const raw = err instanceof Error ? err.message : "Unknown error";
    const friendly =
      raw === "fetch failed" || raw.includes("ECONNREFUSED") || raw.includes("ENOTFOUND")
        ? `Cannot reach the backend at ${BACKEND_URL}. ` +
          `Make sure BACKEND_URL is set in your Vercel environment variables ` +
          `(Settings → Environment Variables → BACKEND_URL = https://ai-backend-00fy.onrender.com).`
        : raw;

    return NextResponse.json({ success: false, error: friendly }, { status: 502 });
  }
}
