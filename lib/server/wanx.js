import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const configPath = path.join(process.env.AUTO_IMG_HOME || process.cwd(), ".wanx.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readWanxConfig() {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    return {
      apiKey: String(parsed.apiKey || "").trim(),
      workspaceId: String(parsed.workspaceId || "").trim()
    };
  } catch {
    return { apiKey: "", workspaceId: "" };
  }
}

export function publicWanxConfig(config) {
  const key = config.apiKey || "";
  const hint = key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : key ? "已保存" : "";
  return {
    saved: Boolean(key),
    keyHint: hint,
    workspaceId: config.workspaceId || ""
  };
}

export async function saveWanxConfig(input) {
  const current = await readWanxConfig();
  const apiKey = String(input.apiKey || "").trim() || current.apiKey;
  const workspaceId = input.workspaceId === undefined ? current.workspaceId : String(input.workspaceId || "").trim();
  if (!apiKey) {
    throw new Error("先填写万相 API Key。");
  }
  await writeFile(configPath, JSON.stringify({ apiKey, workspaceId }), { mode: 0o600 });
  await chmod(configPath, 0o600);
  return publicWanxConfig({ apiKey, workspaceId });
}

function apiRoot(config) {
  if (config.workspaceId) {
    return `https://${config.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`;
  }
  return "https://dashscope.aliyuncs.com/api/v1";
}

async function dashscope(config, pathname, { method, body }) {
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  const init = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    headers["X-DashScope-Async"] = "enable";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${apiRoot(config)}${pathname}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code) {
    throw new Error(payload.message || payload.code || "万相请求失败。");
  }
  return payload;
}

export async function editWithMask({ baseBytes, maskBytes, prompt }) {
  const config = await readWanxConfig();
  if (!config.apiKey) {
    throw new Error("还没有保存万相 API Key。");
  }
  const created = await dashscope(config, "/services/aigc/image2image/image-synthesis", {
    method: "POST",
    body: {
      model: "wanx2.1-imageedit",
      input: {
        function: "description_edit_with_mask",
        prompt: prompt || "",
        base_image_url: `data:image/jpeg;base64,${Buffer.from(baseBytes).toString("base64")}`,
        mask_image_url: `data:image/png;base64,${Buffer.from(maskBytes).toString("base64")}`
      },
      parameters: { n: 1 }
    }
  });
  const taskId = created.output?.task_id;
  if (!taskId) {
    throw new Error(created.message || "万相没有返回任务。");
  }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const task = await dashscope(config, `/tasks/${taskId}`, { method: "GET" });
    const status = task.output?.task_status;
    if (status === "SUCCEEDED") {
      const url = task.output?.results?.[0]?.url;
      if (!url) {
        throw new Error("万相没有返回图片地址。");
      }
      const image = await fetch(url);
      if (!image.ok) {
        throw new Error("重绘结果下载失败。");
      }
      return Buffer.from(await image.arrayBuffer());
    }
    if (status === "FAILED" || status === "UNKNOWN" || status === "CANCELED") {
      const detail = task.output?.results?.[0]?.message || task.output?.message || task.message;
      throw new Error(detail || "局部重绘失败。");
    }
  }
  throw new Error("局部重绘超时。");
}
