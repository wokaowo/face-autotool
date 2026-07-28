import { NextResponse } from "next/server";

import { runPythonJson } from "lib/server/python";
import { resolveServerImagePath, resolveUploadPath, saveServerProcessResult } from "lib/server/storage";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    const imagePath =
      body.sourceType === "server"
        ? await resolveServerImagePath(body.imagePath)
        : await resolveUploadPath(body.imageId);

    if (!body.keepBox && !body.eraseBoxes?.length) {
      return NextResponse.json({ error: "Missing selected face action." }, { status: 400 });
    }

    const args = [
      "process",
      "--image",
      imagePath,
      "--face-ratio",
      String(body.faceRatio ?? 0.45)
    ];

    if (body.keepBox) {
      args.push("--keep-box-json", JSON.stringify(body.keepBox));
    }

    if (body.cropBox) {
      args.push("--crop-box-json", JSON.stringify(body.cropBox));
    }

    if (body.eraseBoxes?.length) {
      args.push("--erase-boxes-json", JSON.stringify(body.eraseBoxes));
    }

    const payload = await runPythonJson(args);
    const saved =
      body.sourceType === "server"
        ? await saveServerProcessResult(body.outputRoot, body.relativePath, payload)
        : {};

    return NextResponse.json({
      ...payload,
      saved
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Processing failed." },
      { status: 500 }
    );
  }
}
