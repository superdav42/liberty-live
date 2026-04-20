// Liberty Live - Server
// Express web server + WebSocket bridge between orchestrator and browser frontend.

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Orchestrator } from "./orchestrator.js";
import { checkOllama } from "./ollama.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;

// --- Express ---
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

// Health check
app.get("/api/health", async (_req, res) => {
  const ollama = await checkOllama();
  res.json({
    status: "ok",
    ollama,
    clients: orchestrator.clients.size,
    running: orchestrator.running,
    segments: orchestrator.segmentCount,
  });
});

// Start/stop the show
app.post("/api/show/start", (_req, res) => {
  if (orchestrator.running) {
    return res.json({ status: "already_running" });
  }
  orchestrator.start().catch((err) => {
    console.error("[server] Show crashed:", err);
  });
  res.json({ status: "started" });
});

app.post("/api/show/stop", (_req, res) => {
  orchestrator.stop();
  res.json({ status: "stopped" });
});

// Viewer comment endpoint
app.post("/api/comment", (req, res) => {
  const { name, comment } = req.body;
  if (!comment) {
    return res.status(400).json({ error: "comment required" });
  }
  orchestrator.handleViewerComment(name || "Anonymous", comment);
  res.json({ status: "queued" });
});

// --- HTTP + WebSocket server ---
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const orchestrator = new Orchestrator();

wss.on("connection", (ws) => {
  console.log("[ws] Client connected");
  orchestrator.addClient(ws);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "comment") {
        orchestrator.handleViewerComment(msg.name || "Anonymous", msg.comment);
      }
    } catch {
      // ignore bad messages
    }
  });
});

// --- Start ---
server.listen(PORT, async () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║         LIBERTY LIVE - AI Talk Show       ║
  ║     Unfiltered. Unregulated. Unstoppable. ║
  ╠═══════════════════════════════════════════╣
  ║  Frontend:  http://localhost:${PORT}          ║
  ║  API:       http://localhost:${PORT}/api      ║
  ║  WebSocket: ws://localhost:${PORT}/ws         ║
  ╚═══════════════════════════════════════════╝
  `);

  // Check Ollama
  const ollama = await checkOllama();
  if (!ollama.ok) {
    console.error("  [!] Ollama is not reachable at", process.env.OLLAMA_HOST || "http://127.0.0.1:11434");
    console.error("      Start Ollama first: ollama serve");
  } else if (!ollama.available) {
    console.error(`  [!] Model "${ollama.model}" not found. Available: ${ollama.models.join(", ")}`);
    console.error(`      Pull it: ollama pull ${ollama.model}`);
  } else {
    console.log(`  [ok] Ollama ready with model: ${ollama.model}`);
  }

  console.log("  [..] Open the frontend and click 'Start Show' to begin.\n");
});
