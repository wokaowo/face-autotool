import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

export async function GET(request) {
  const url = new URL(request.url);
  const rootParam = url.searchParams.get("root") || "";
  const fileParam = url.searchParams.get("file") || "";
  if (!rootParam || !fileParam || path.isAbsolute(fileParam)) {
    return NextResponse.json({ error: "文件地址无效。" }, { status: 400 });
  }

  const root = path.resolve(rootParam);
  const target = path.resolve(root, fileParam);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(rootPrefix)) {
    return NextResponse.json({ error: "文件不在任务目录里。" }, { status: 400 });
  }

  const type = TYPES[path.extname(target).toLowerCase()];
  if (!type) {
    return NextResponse.json({ error: "只能读取图片。" }, { status: 400 });
  }

  try {
    await access(path.join(root, "job.json"));
    const bytes = await readFile(target);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, no-store"
      }
    });
  } catch {
    return NextResponse.json({ error: "找不到这张图。" }, { status: 404 });
  }
}
