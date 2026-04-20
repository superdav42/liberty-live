// Liberty Live - Launcher
// Starts HeadTTS and the show server as child processes.

import { spawn } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const HEADTTS_SCRIPT = join(ROOT, "headtts", "modules", "headtts-node.mjs");
const SERVER_SCRIPT = join(ROOT, "src", "server.js");

const children = [];

function launchProcess(name, script, args = [], cwd = ROOT) {
  const child = spawn("node", [script, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  child.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.log(`[${name}] ${line}`);
    }
  });

  child.stderr.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.error(`[${name}] ${line}`);
    }
  });

  child.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`);
  });

  children.push(child);
  return child;
}

// Clean shutdown
function shutdown() {
  console.log("\nShutting down...");
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Start ---
console.log(`
  Starting Liberty Live...
`);

// 1. Start HeadTTS if available
if (existsSync(HEADTTS_SCRIPT)) {
  console.log("  [1/2] Starting HeadTTS (Kokoro TTS on port 8882)...");
  launchProcess("headtts", HEADTTS_SCRIPT, [], join(ROOT, "headtts"));
} else {
  console.log("  [1/2] HeadTTS not found — run 'npm run setup' to install it.");
  console.log("         Continuing without voice (subtitles only).");
}

// 2. Start the show server (brief delay so TTS can start loading)
setTimeout(() => {
  console.log("  [2/2] Starting show server...\n");
  launchProcess("server", SERVER_SCRIPT);
}, 1500);
