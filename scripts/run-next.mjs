import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , nextCommand, ...forwardedArgs] = process.argv;

if (!nextCommand) {
  console.error("Missing Next.js command.");
  process.exit(1);
}

function splitNodeOptions(value) {
  if (!value) {
    return [];
  }

  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g;

  for (const match of value.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }

  return tokens;
}

function sanitizeNodeOptions(value) {
  const tokens = splitNodeOptions(value);
  const kept = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--localstorage-file") {
      index += 1;
      continue;
    }

    if (token.startsWith("--localstorage-file=")) {
      continue;
    }

    kept.push(token);
  }

  return kept.join(" ");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nextBin = path.join(__dirname, "..", "node_modules", "next", "dist", "bin", "next");
const sanitizedNodeOptions = sanitizeNodeOptions(process.env.NODE_OPTIONS);
const nodeArgs = ["--no-experimental-webstorage", nextBin, nextCommand, ...forwardedArgs];

const child = spawn(process.execPath, nodeArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: sanitizedNodeOptions
  }
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
