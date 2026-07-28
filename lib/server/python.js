import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const cacheRoot = path.join(process.cwd(), ".gui-cache");
const pythonCandidates = [
  path.join(process.cwd(), "venv", "bin", "python"),
  "python",
  "python3"
];

let child = null;
let readline = null;
let pending = new Map();
let starting = false;

async function resolvePythonExecutable() {
  for (const candidate of pythonCandidates) {
    if (!candidate.includes(path.sep)) {
      return candidate;
    }

    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return "python3";
}

function ensureChild() {
  if (child && !child.killed && child.exitCode === null) {
    return;
  }
  startChild();
}

async function startChild() {
  if (starting) {
    return;
  }
  starting = true;

  const pythonExecutable = await resolvePythonExecutable();

  child = spawn(pythonExecutable, ["gui_service.py", "serve"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MPLCONFIGDIR: path.join(cacheRoot, "matplotlib"),
      YOLO_CONFIG_DIR: path.join(cacheRoot, "ultralytics")
    }
  });

  readline = createInterface({ input: child.stdout });

  readline.on("line", (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (parsed.status === "ready") {
      starting = false;
      return;
    }

    const id = parsed._id;
    if (id && pending.has(id)) {
      const { resolve, reject } = pending.get(id);
      pending.delete(id);
      if (parsed.error) {
        reject(new Error(parsed.error));
      } else {
        resolve(parsed);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.warn(text);
    }
  });

  child.on("exit", () => {
    starting = false;
    const error = new Error("Python process exited unexpectedly.");
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
    child = null;
    readline = null;
  });
}

export async function runPythonJson(args) {
  await mkdir(cacheRoot, { recursive: true });
  ensureChild();

  while (starting) {
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!child || child.killed || child.exitCode !== null) {
    throw new Error("Python process is not running.");
  }

  const id = randomUUID();

  const command = buildCommand(args, id);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(command + "\n");
  });
}

function buildCommand(args, id) {
  const action = args[0];

  if (action === "detect") {
    const cmd = { cmd: "detect", _id: id };
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i];
      const val = args[i + 1];
      if (key === "--image") cmd.image = val;
      else if (key === "--model") cmd.model = val;
      else if (key === "--conf") cmd.conf = parseFloat(val);
      else if (key === "--device") cmd.device = val;
    }
    return JSON.stringify(cmd);
  }

  if (action === "process") {
    const cmd = { cmd: "process", _id: id };
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i];
      const val = args[i + 1];
      if (key === "--image") cmd.image = val;
      else if (key === "--keep-box-json") cmd.keepBox = JSON.parse(val);
      else if (key === "--crop-box-json") cmd.cropBox = JSON.parse(val);
      else if (key === "--erase-boxes-json") cmd.eraseBoxes = JSON.parse(val);
      else if (key === "--face-ratio") cmd.faceRatio = parseFloat(val);
    }
    return JSON.stringify(cmd);
  }

  return JSON.stringify({ cmd: action, _id: id });
}

export function shutdown() {
  if (child && !child.killed) {
    try {
      child.stdin.write(JSON.stringify({ cmd: "exit" }) + "\n");
    } catch {
      // stdin may already be closed
    }
    setTimeout(() => {
      if (child && !child.killed) {
        child.kill();
      }
    }, 3000);
  }
}
