import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const appHome = process.env.AUTO_IMG_HOME || process.cwd();
const cacheRoot = path.join(appHome, ".gui-cache");
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

  const bundled = process.env.AUTO_IMG_BIN;
  const pythonExecutable = bundled || (await resolvePythonExecutable());
  const pythonArgs = bundled ? ["--python-service"] : ["gui_service.py", "serve"];

  child = spawn(pythonExecutable, pythonArgs, {
    cwd: appHome,
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
      const entry = pending.get(id);
      pending.delete(id);
      if (parsed.error && !entry.passError) {
        entry.reject(new Error(parsed.error));
      } else {
        entry.resolve(parsed);
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

export async function runPythonCommand(command) {
  await mkdir(cacheRoot, { recursive: true });
  ensureChild();

  while (starting) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (!child || child.killed || child.exitCode !== null) {
    throw new Error("Python process is not running.");
  }

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, passError: true });
    child.stdin.write(JSON.stringify({ ...command, _id: id }) + "\n");
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

  if (action === "filter_faces") {
    const cmd = { cmd: "filter_faces", _id: id };
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i];
      const val = args[i + 1];
      if (key === "--input") cmd.inputPath = val;
      else if (key === "--output") cmd.outputPath = val;
      else if (key === "--conf") cmd.conf = parseFloat(val);
      else if (key === "--device") cmd.device = val;
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
