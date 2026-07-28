import { NextResponse } from "next/server";

import { importServerImages } from "lib/server/storage";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    const payload = await importServerImages(body.inputPath, body.outputPath);
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed." },
      { status: 500 }
    );
  }
}
