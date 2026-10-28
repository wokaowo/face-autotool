import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export async function GET(request) {
  const requested = new URL(request.url).searchParams.get("path");
  const target = path.resolve(requested && requested.trim() ? requested : os.homedir());

  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      return NextResponse.json({ error: "这不是文件夹。" }, { status: 400 });
    }

    const entries = await readdir(target, { withFileTypes: true });
    const directories = [];
    let imageCount = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.isDirectory()) {
        directories.push({ name: entry.name, path: path.join(target, entry.name) });
      } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        imageCount += 1;
      }
    }
    directories.sort((left, right) => left.name.localeCompare(right.name, "zh"));
    const parent = path.dirname(target);
    return NextResponse.json({
      path: target,
      parent: parent === target ? "" : parent,
      directories,
      imageCount
    });
  } catch (error) {
    const missing = error && error.code === "ENOENT";
    return NextResponse.json({ error: missing ? "目录不存在。" : "无法读取这个目录。" }, { status: 400 });
  }
}
