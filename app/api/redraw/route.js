import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { runPythonCommand } from "lib/server/python";
import { editWithMask, publicWanxConfig, readWanxConfig, saveWanxConfig } from "lib/server/wanx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function safeResultPath(outputPath, relative) {
  const output = path.resolve(outputPath);
  const target = path.resolve(output, relative);
  const root = path.resolve(output, "dataset", "redraw");
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("结果路径无效。");
  }
  return target;
}

async function jobSample(outputPath, sampleId, op, redraw) {
  const result = await runPythonCommand({
    cmd: "job_sample",
    outputPath,
    sampleId,
    op,
    redraw
  });
  if (result?.error && !result.status) {
    throw new Error(result.error);
  }
  return result;
}

export async function GET() {
  const config = await readWanxConfig();
  return NextResponse.json(publicWanxConfig(config));
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (body.action === "config") {
      const saved = await saveWanxConfig(body);
      return NextResponse.json(saved);
    }
    if (body.action === "run") {
      const outputPath = String(body.outputPath || "");
      const sampleId = String(body.sampleId || "");
      const prepared = await jobSample(outputPath, sampleId, "redraw_prepare");
      const sample = (prepared.samples || []).find((item) => item.id === sampleId);
      const redraw = sample?.redraw;
      if (!redraw?.basePath || !redraw?.maskPath) {
        throw new Error("没有生成底图和蒙版。");
      }
      const output = path.resolve(outputPath);
      const base = await readFile(path.resolve(output, redraw.basePath));
      const mask = await readFile(path.resolve(output, redraw.maskPath));
      const bytes = await editWithMask({ baseBytes: base, maskBytes: mask, prompt: String(body.prompt || "") });
      const resultRelative = redraw.basePath.replace(/\.[^.]+$/, "-result.jpg");
      const resultPath = safeResultPath(outputPath, resultRelative);
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(resultPath, bytes);
      const stored = await jobSample(outputPath, sampleId, "redraw_store", {
        resultPath: resultRelative,
        prompt: String(body.prompt || "")
      });
      return NextResponse.json(stored);
    }
    if (body.action === "save") {
      const stored = await jobSample(String(body.outputPath || ""), String(body.sampleId || ""), "redraw_save");
      return NextResponse.json(stored);
    }
    return NextResponse.json({ error: "未知重绘操作。" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "局部重绘失败。" }, { status: 400 });
  }
}
