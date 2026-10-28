import { NextResponse } from "next/server";

import { respondJob } from "lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求格式不对。" }, { status: 400 });
  }
  return respondJob(body);
}
