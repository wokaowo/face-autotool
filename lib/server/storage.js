import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const cacheRoot = path.join(process.cwd(), ".gui-cache");
const uploadsRoot = path.join(cacheRoot, "uploads");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function ensureUploadRoot() {
  await mkdir(uploadsRoot, { recursive: true });
}

function cleanExtension(filename) {
  const extension = path.extname(filename || "").toLowerCase();
  return extension || ".jpg";
}

export async function saveUpload(file) {
  await ensureUploadRoot();
  const extension = cleanExtension(file.name);
  const id = `${randomUUID()}${extension}`;
  const targetPath = path.join(uploadsRoot, id);
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(targetPath, bytes);
  return { id, path: targetPath };
}

export async function resolveUploadPath(imageId) {
  await ensureUploadRoot();
  const safeId = path.basename(imageId || "");
  if (!safeId || safeId !== imageId) {
    throw new Error("Invalid image id.");
  }
  return path.join(uploadsRoot, safeId);
}

function isImagePath(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function walkImages(rootDir, currentDir, items) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkImages(rootDir, entryPath, items);
      continue;
    }

    if (!entry.isFile() || !isImagePath(entryPath)) {
      continue;
    }

    items.push({
      imagePath: entryPath,
      name: path.basename(entryPath),
      pathLabel: path.relative(rootDir, entryPath) || path.basename(entryPath),
      relativePath: path.relative(rootDir, entryPath) || path.basename(entryPath)
    });
  }
}

export async function resolveServerImagePath(inputPath) {
  const resolvedPath = path.resolve(process.cwd(), String(inputPath || "").trim());
  let details;

  try {
    details = await stat(resolvedPath);
  } catch {
    throw new Error(`找不到服务端路径：${resolvedPath}`);
  }

  if (!details.isFile()) {
    throw new Error(`这不是文件：${resolvedPath}`);
  }

  if (!isImagePath(resolvedPath)) {
    throw new Error(`不支持的图片格式：${resolvedPath}`);
  }

  return resolvedPath;
}

function defaultOutputRoot(inputPath, kind) {
  if (kind === "directory") {
    return path.join(path.dirname(inputPath), `${path.basename(inputPath)}-face-output`);
  }

  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}-face-output`);
}

export async function importServerImages(inputPath, outputPath) {
  const resolvedInputPath = path.resolve(process.cwd(), String(inputPath || "").trim());

  if (!inputPath || !String(inputPath).trim()) {
    throw new Error("请输入服务端图片路径。");
  }

  let details;
  try {
    details = await stat(resolvedInputPath);
  } catch {
    throw new Error(`找不到服务端路径：${resolvedInputPath}`);
  }

  const kind = details.isDirectory() ? "directory" : details.isFile() ? "file" : "other";
  if (kind === "other") {
    throw new Error("输入路径必须是图片文件或文件夹。");
  }

  const resolvedOutputRoot = path.resolve(
    process.cwd(),
    String(outputPath || "").trim() || defaultOutputRoot(resolvedInputPath, kind)
  );

  const items = [];
  if (kind === "directory") {
    await walkImages(resolvedInputPath, resolvedInputPath, items);
  } else {
    if (!isImagePath(resolvedInputPath)) {
      throw new Error(`不支持的图片格式：${resolvedInputPath}`);
    }

    items.push({
      imagePath: resolvedInputPath,
      name: path.basename(resolvedInputPath),
      pathLabel: resolvedInputPath,
      relativePath: path.basename(resolvedInputPath)
    });
  }

  if (!items.length) {
    throw new Error("目标路径里没有可处理的图片。");
  }

  await mkdir(resolvedOutputRoot, { recursive: true });

  return {
    mode: kind === "directory" ? "batch" : "single",
    inputPath: resolvedInputPath,
    outputRoot: resolvedOutputRoot,
    items: items.map((item) => ({
      localId: `server-${randomUUID()}`,
      sourceType: "server",
      previewUrl: null,
      status: "queued",
      detection: null,
      keepFaceId: null,
      cropBox: null,
      cropBoxEdited: false,
      eraseFaceIds: [],
      result: null,
      error: "",
      name: item.name,
      pathLabel: item.pathLabel,
      serverImagePath: item.imagePath,
      relativePath: item.relativePath,
      outputRoot: resolvedOutputRoot
    }))
  };
}

function outputStem(relativePathValue) {
  const normalized = path.normalize(relativePathValue || "");
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid output path.");
  }

  const extension = path.extname(normalized);
  return extension ? normalized.slice(0, -extension.length) : normalized;
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid image payload.");
  }

  const [, mime, base64Payload] = match;
  const extension = mime === "image/png" ? ".png" : ".jpg";
  return {
    extension,
    buffer: Buffer.from(base64Payload, "base64")
  };
}

export async function saveServerProcessResult(outputRoot, relativePathValue, payload) {
  const resolvedOutputRoot = path.resolve(process.cwd(), String(outputRoot || "").trim());
  const stem = outputStem(relativePathValue);
  const saved = {};

  await mkdir(resolvedOutputRoot, { recursive: true });

  if (payload.crop?.dataUrl) {
    const crop = decodeDataUrl(payload.crop.dataUrl);
    const cropPath = path.join(resolvedOutputRoot, `${stem}-crop${crop.extension}`);
    await mkdir(path.dirname(cropPath), { recursive: true });
    await writeFile(cropPath, crop.buffer);
    saved.cropPath = cropPath;
  }

  if (payload.painted?.dataUrl) {
    const painted = decodeDataUrl(payload.painted.dataUrl);
    const paintedPath = path.join(resolvedOutputRoot, `${stem}-painted${painted.extension}`);
    await mkdir(path.dirname(paintedPath), { recursive: true });
    await writeFile(paintedPath, painted.buffer);
    saved.paintedPath = paintedPath;
  }

  return saved;
}
