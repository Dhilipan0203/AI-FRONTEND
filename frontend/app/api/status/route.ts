import { NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

export const maxDuration = 10;

export async function GET() {
  try {
    const res = await fetch(`${BACKEND_URL}/status`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Backend unavailable" }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Cannot reach backend" }, { status: 502 });
  }
}
