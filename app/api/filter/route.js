import path from "node:path";
import { NextResponse } from "next/server";

import { runPythonJson } from "lib/server/python";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    const inputPath = String(body.inputPath || "").trim();
    const outputPath = String(body.outputPath || "").trim();

    if (!inputPath) {
      return NextResponse.json({ error: "请输入待筛选的文件夹路径。" }, { status: 400 });
    }
    if (!outputPath) {
      return NextResponse.json({ error: "请输入输出路径。" }, { status: 400 });
    }

    const payload = await runPythonJson([
      "filter_faces",
      "--input",
      path.resolve(process.cwd(), inputPath),
      "--output",
      path.resolve(process.cwd(), outputPath),
      "--conf",
      "0.25",
      "--device",
      "auto"
    ]);

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "人脸筛选失败。" },
      { status: 500 }
    );
  }
}
