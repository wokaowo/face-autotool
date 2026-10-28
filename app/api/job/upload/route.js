import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function safeSegment(value, keepExtension) {
  const extension = keepExtension ? path.extname(value).toLowerCase() : "";
  const stemSource = keepExtension ? path.basename(value, path.extname(value)) : value;
  const stem = stemSource
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[ ._]+|[ ._]+$/g, "");
  return {
    stem: stem || "image",
    extension: IMAGE_EXTENSIONS.has(extension) ? extension : ""
  };
}

export async function POST(request) {
  try {
    const form = await request.formData();
    const outputPath = String(form.get("outputPath") || "").trim();
    if (!outputPath) {
      return NextResponse.json({ error: "先填写输出目录。" }, { status: 400 });
    }

    const output = path.resolve(outputPath);
    const incoming = path.join(output, "incoming");
    await mkdir(incoming, { recursive: true });
    const incomingPrefix = `${incoming}${path.sep}`;
    const files = form.getAll("files").filter((item) => item && typeof item.arrayBuffer === "function");
    if (!files.length) {
      return NextResponse.json({ error: "没有收到图片。" }, { status: 400 });
    }

    const saved = [];
    const skipped = [];
    for (const file of files) {
      const relative = String(file.name || "image");
      const parts = relative.split(/[/\\]/).filter(Boolean);
      const safeParts = [];
      let reason = "";
      parts.forEach((part, index) => {
        const last = index === parts.length - 1;
        const safe = safeSegment(part, last);
        if (last && !safe.extension) {
          reason = "不是支持的图片";
          return;
        }
        safeParts.push(last ? `${safe.stem}${safe.extension}` : safe.stem);
      });
      if (reason || !safeParts.length) {
        skipped.push({ name: relative, reason: reason || "文件名无效" });
        continue;
      }

      let destination = path.resolve(incoming, ...safeParts);
      if (!destination.startsWith(incomingPrefix)) {
        skipped.push({ name: relative, reason: "路径无效" });
        continue;
      }
      try {
        await access(destination);
        const hash = createHash("sha1").update(`${relative}:${file.size}:${Date.now()}`).digest("hex").slice(0, 6);
        const extension = path.extname(destination);
        const stem = path.basename(destination, extension);
        destination = path.join(path.dirname(destination), `${stem}_${hash}${extension}`);
      } catch {
        // The name is free.
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(await file.arrayBuffer()));
      saved.push(path.relative(incoming, destination));
    }

    if (!saved.length) {
      return NextResponse.json({ error: "没有可保存的图片。", saved, skipped }, { status: 400 });
    }
    return NextResponse.json({ inputPath: incoming, outputPath: output, saved, skipped });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "上传失败。" }, { status: 500 });
  }
}
