// Liberty Live - Show Orchestrator
// The main loop that drives the 24/7 broadcast.
// Picks segments, generates content via Ollama, and pushes it to connected clients.

import { streamChat } from "./ollama.js";
import { fetchHeadlines, markCovered } from "./news.js";
import { PERSONALITY, detectMood, pickSegmentType, pickFillerPrompt } from "./personality.js";

export class Orchestrator {
  constructor() {
    this.running = false;
    this.clients = new Set(); // WebSocket clients
    this.conversationHistory = [];
    this.maxHistoryLength = 20; // keep last N exchanges
    this.headlineCache = [];
    this.lastNewsFetch = 0;
    this.newsFetchInterval = 5 * 60 * 1000; // 5 minutes
    this.segmentPause = 3000; // ms pause between segments
    this.segmentCount = 0;
  }

  /**
   * Register a WebSocket client to receive show events.
   */
  addClient(ws) {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));

    // Send current state to new client
    this.broadcast({ type: "status", running: this.running, segments: this.segmentCount });
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(data);
      }
    }
  }

  /**
   * Handle a viewer comment from the frontend.
   */
  handleViewerComment(name, comment) {
    if (!this.running) return;

    // Queue it as the next segment by injecting into conversation
    const prompt = `A viewer named "${name}" says in chat: "${comment}". Respond to them directly.`;
    this._queuedViewerPrompt = prompt;
  }

  /**
   * Start the show loop.
   */
  async start() {
    if (this.running) return;
    this.running = true;
    this.segmentCount = 0;

    console.log("[orchestrator] Show started");
    this.broadcast({ type: "show_start" });

    // Opening line
    await this._runSegment(
      "Hey folks, welcome back to the show! Liberty here, live and unfiltered. " +
      "Let's see what fresh chaos the world has cooked up for us today."
    );

    // Main loop
    while (this.running) {
      try {
        await this._nextSegment();
      } catch (err) {
        console.error("[orchestrator] Segment error:", err.message);
        // Brief pause then continue — the show must go on
        await this._sleep(5000);
      }
    }

    console.log("[orchestrator] Show stopped");
    this.broadcast({ type: "show_stop" });
  }

  /**
   * Stop the show loop gracefully.
   */
  stop() {
    this.running = false;
  }

  // --- Internal methods ---

  async _nextSegment() {
    // Check for queued viewer comment first
    if (this._queuedViewerPrompt) {
      const prompt = this._queuedViewerPrompt;
      this._queuedViewerPrompt = null;
      await this._generateAndSpeak(prompt);
      return;
    }

    const segment = pickSegmentType();

    switch (segment.type) {
      case "news_reaction":
        await this._newsSegment(segment.prompt);
        break;

      case "monologue":
        await this._monologueSegment(segment.prompt);
        break;

      case "viewer_qa":
        // If no viewer comment queued, fall through to filler
        if (this._queuedViewerPrompt) {
          const prompt = this._queuedViewerPrompt;
          this._queuedViewerPrompt = null;
          await this._generateAndSpeak(prompt);
        } else {
          await this._fillerSegment();
        }
        break;

      case "filler":
        await this._fillerSegment();
        break;

      default:
        await this._fillerSegment();
    }

    // Pause between segments
    await this._sleep(this.segmentPause + Math.random() * 2000);
  }

  async _newsSegment(promptPrefix) {
    await this._refreshHeadlines();

    if (this.headlineCache.length === 0) {
      // No fresh news, do a filler instead
      await this._fillerSegment();
      return;
    }

    const headline = this.headlineCache.shift();
    markCovered(headline);

    let prompt = `${promptPrefix} "${headline.title}"`;
    if (headline.snippet) {
      prompt += `\n\nHere's a bit more context: ${headline.snippet}`;
    }
    prompt += `\n\n(Source: ${headline.source})`;

    this.broadcast({
      type: "segment_info",
      segmentType: "news_reaction",
      headline: headline.title,
      source: headline.source,
    });

    await this._generateAndSpeak(prompt);
  }

  async _monologueSegment(promptPrefix) {
    // Pick a topic from recent news or a random theme
    await this._refreshHeadlines();

    let topic;
    if (this.headlineCache.length > 0 && Math.random() > 0.4) {
      const headline = this.headlineCache.shift();
      markCovered(headline);
      topic = headline.title;
    } else {
      const topics = [
        "government spending", "free speech on the internet", "the federal reserve",
        "occupational licensing", "the war on drugs", "eminent domain abuse",
        "corporate welfare", "civil asset forfeiture", "school choice",
        "the surveillance state", "zoning laws destroying housing",
      ];
      topic = topics[Math.floor(Math.random() * topics.length)];
    }

    const prompt = `${promptPrefix} ${topic}. Really get into it — this is your soapbox moment.`;

    this.broadcast({ type: "segment_info", segmentType: "monologue", topic });

    await this._generateAndSpeak(prompt);
  }

  async _fillerSegment() {
    const prompt = pickFillerPrompt();
    this.broadcast({ type: "segment_info", segmentType: "filler" });
    await this._generateAndSpeak(prompt);
  }

  /**
   * Core method: send prompt to Ollama, stream response, broadcast to clients.
   */
  async _generateAndSpeak(userPrompt) {
    this.segmentCount++;

    // Build messages with personality + recent history
    const messages = [
      { role: "system", content: PERSONALITY.systemPrompt },
      ...this.conversationHistory.slice(-this.maxHistoryLength),
      { role: "user", content: userPrompt },
    ];

    // Collect the full response while streaming
    let fullResponse = "";
    let sentenceBuffer = "";

    this.broadcast({ type: "generating_start", prompt: userPrompt.slice(0, 100) });

    for await (const chunk of streamChat(messages)) {
      fullResponse += chunk;
      sentenceBuffer += chunk;

      // Send sentences to TTS as they complete (on sentence-ending punctuation)
      const sentences = splitSentences(sentenceBuffer);
      if (sentences.length > 1) {
        // All but the last are complete sentences
        for (let i = 0; i < sentences.length - 1; i++) {
          const sentence = sentences[i].trim();
          if (sentence) {
            const mood = detectMood(sentence);
            this.broadcast({
              type: "speak",
              text: sentence,
              mood,
            });
          }
        }
        sentenceBuffer = sentences[sentences.length - 1];
      }
    }

    // Flush remaining text
    if (sentenceBuffer.trim()) {
      const mood = detectMood(sentenceBuffer);
      this.broadcast({
        type: "speak",
        text: sentenceBuffer.trim(),
        mood,
      });
    }

    // Update conversation history
    this.conversationHistory.push(
      { role: "user", content: userPrompt },
      { role: "assistant", content: fullResponse }
    );

    // Trim history if too long
    if (this.conversationHistory.length > this.maxHistoryLength * 2) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength * 2);
    }

    this.broadcast({ type: "generating_done" });
  }

  async _refreshHeadlines() {
    const now = Date.now();
    if (now - this.lastNewsFetch < this.newsFetchInterval && this.headlineCache.length > 0) {
      return;
    }

    try {
      const fresh = await fetchHeadlines(15);
      this.headlineCache = fresh;
      this.lastNewsFetch = now;
      console.log(`[orchestrator] Fetched ${fresh.length} fresh headlines`);
    } catch (err) {
      console.error("[orchestrator] Failed to fetch headlines:", err.message);
    }
  }

  async _runSegment(text) {
    const mood = detectMood(text);
    this.broadcast({ type: "speak", text, mood });
    // Wait for approximate speaking time (rough estimate: 150ms per word)
    const words = text.split(/\s+/).length;
    await this._sleep(words * 150 + 1000);
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Split text on sentence boundaries, keeping the delimiter with the sentence.
 */
function splitSentences(text) {
  // Split on . ! ? followed by a space or end of string, but not on common abbreviations
  return text.split(/(?<=[.!?])\s+/);
}
