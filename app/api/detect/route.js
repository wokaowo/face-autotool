import path from "node:path";
import { NextResponse } from "next/server";

import { runPythonJson } from "lib/server/python";
import { resolveServerImagePath, saveUpload } from "lib/server/storage";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    let imagePath;
    let imageId = null;

    if (contentType.includes("application/json")) {
      const body = await request.json();
      imagePath = await resolveServerImagePath(body.imagePath);
      imageId = body.imagePath;
    } else {
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file || typeof file.arrayBuffer !== "function") {
        return NextResponse.json({ error: "Missing image file." }, { status: 400 });
      }

      const saved = await saveUpload(file);
      imagePath = saved.path;
      imageId = saved.id;
    }
    const payload = await runPythonJson([
      "detect",
      "--image",
      imagePath,
      "--model",
      path.join(process.cwd(), "face_yolov8s.pt"),
      "--conf",
      "0.25",
      "--device",
      "auto"
    ]);

    return NextResponse.json({
      imageId,
      ...payload
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Detection failed." },
      { status: 500 }
    );
  }
}
