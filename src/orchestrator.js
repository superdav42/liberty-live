// Liberty Live - Show Orchestrator
// The main loop that drives the 24/7 broadcast.
// Each segment gets a fresh user prompt + a rolling "show memory" of recent
// segment summaries injected into the system prompt, so Liberty can do
// natural callbacks ("Earlier I was ranting about X, well now look at this...")
// without repeating arguments.
// News segments fetch the article + web search + extract direct quotes so
// the avatar can read passages from the article verbatim.

import { streamChat, checkOllama, chat } from "./ollama.js";
import { fetchHeadlines, markCovered, researchHeadline } from "./news.js";
import { PERSONALITY, pickSegmentType, pickFillerPrompt } from "./personality.js";
import { processSentence } from "./expressions.js";

export class Orchestrator {
  constructor() {
    this.running = false;
    this.clients = new Set(); // WebSocket clients
    this.headlineCache = [];
    this.lastNewsFetch = 0;
    this.newsFetchInterval = 5 * 60 * 1000; // 5 minutes
    this.segmentPause = 1500; // ms pause between segments (reduced for tighter pacing)
    this.segmentCount = 0;

    // Show memory — rolling summary of recent segments so Liberty can do callbacks
    // Each entry: { type, topic, oneLineSummary }
    this.showMemory = [];
    this.maxMemoryEntries = 4;

    // Error recovery config
    this.maxRetries = 3;
    this.baseRetryDelay = 2000; // 2s base, doubles each retry
    this.consecutiveErrors = 0;
    this.lastError = null;
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
   * @param {string} name - Viewer name
   * @param {string} comment - Comment text
   * @param {boolean} urgent - If true, interrupt current speech to respond immediately
   */
  handleViewerComment(name, comment, urgent = false) {
    if (!this.running) return;

    // Queue it as the next segment by injecting into conversation
    const prompt = `A viewer named "${name}" says in chat: "${comment}". Respond to them directly.`;
    
    if (urgent) {
      // Interrupt: clear queue and respond immediately
      this._queuedViewerPrompt = prompt;
      this._interruptQueue = true;
      console.log(`[orchestrator] URGENT comment from ${name}, interrupting queue`);
    } else {
      this._queuedViewerPrompt = prompt;
    }
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

    // Opening line — sent directly (no LLM needed)
    this._sendSentence(
      "Hey folks, welcome back to the show! Liberty here, live and unfiltered. Let us see what fresh chaos the world has cooked up for us today.",
      "happy",
      null,
    );

    // Brief pause for the opening line
    await this._sleep(5000);

    // Main loop with error recovery
    while (this.running) {
      try {
        await this._nextSegment();
        this.consecutiveErrors = 0; // Reset on success
      } catch (err) {
        const isOllamaError = this._isOllamaError(err);
        this.consecutiveErrors++;
        this.lastError = err.message;
        
        console.error(`[orchestrator] Segment error (attempt ${this.consecutiveErrors}/${this.maxRetries}):`, err.message);
        
        if (this.consecutiveErrors >= this.maxRetries) {
          // All retries exhausted — try to revive Ollama connection
          console.error("[orchestrator] Max retries reached. Attempting Ollama revival...");
          const revived = await this._reviveOllama();
          if (!revived) {
            console.error("[orchestrator] Ollama revival failed. Pausing 60s then retrying...");
            await this._sleep(60000);
            this.consecutiveErrors = 0; // Reset to try again
          } else {
            console.log("[orchestrator] Ollama revived.");
            this.consecutiveErrors = 0;
          }
        } else {
          // Exponential backoff before retry
          const delay = this.baseRetryDelay * Math.pow(2, this.consecutiveErrors - 1);
          console.log(`[orchestrator] Retrying in ${delay}ms...`);
          await this._sleep(delay);
        }
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
      await this._generateSegment(prompt, "viewer_qa", { topic: "viewer comment" });
      return;
    }

    const segment = pickSegmentType();

    switch (segment.type) {
      case "news_reaction":
        await this._newsSegment();
        break;

      case "monologue":
        await this._monologueSegment(segment.prompt);
        break;

      case "viewer_qa":
        // If no viewer comment queued, fall through to filler
        if (this._queuedViewerPrompt) {
          const prompt = this._queuedViewerPrompt;
          this._queuedViewerPrompt = null;
          await this._generateSegment(prompt, "viewer_qa", { topic: "viewer comment" });
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

    // Pause between segments — kept short for tighter pacing
    await this._sleep(this.segmentPause + Math.random() * 1000);
  }

  /**
   * News segment: fetch article, research it, then react.
   * Includes show memory so Liberty can do callbacks to earlier topics.
   */
  async _newsSegment() {
    await this._refreshHeadlines();

    if (this.headlineCache.length === 0) {
      await this._fillerSegment();
      return;
    }

    const headline = this.headlineCache.shift();
    markCovered(headline);

    // Research: fetch full article + web search in parallel
    const research = await researchHeadline(headline);

    // Broadcast article details to frontend BEFORE generation starts so the
    // article panel can render while Liberty is thinking.
    this.broadcast({
      type: "segment_info",
      segmentType: "news_reaction",
      headline: headline.title,
      source: headline.source,
      url: headline.link || null,
      articleText: research.articleText || headline.snippet || "",
      quotes: research.quotes || [],
    });

    // Build a rich prompt with all the research context
    let prompt = `ARTICLE TO REACT TO:\nHeadline: "${headline.title}"\nSource: ${headline.source}`;

    if (research.articleText) {
      prompt += `\n\nFull article text:\n${research.articleText}`;
    } else if (headline.snippet) {
      prompt += `\n\nSummary: ${headline.snippet}`;
    }

    if (research.quotes && research.quotes.length > 0) {
      prompt += "\n\nDIRECT QUOTES FROM THE ARTICLE (read at least one of these aloud verbatim, in quotation marks, and react to it):";
      for (const q of research.quotes) {
        prompt += `\n- "${q}"`;
      }
    }

    if (research.searchResults.length > 0) {
      prompt += "\n\nADDITIONAL CONTEXT FROM WEB SEARCH:";
      for (const result of research.searchResults) {
        prompt += `\n- ${result.title}: ${result.snippet}`;
      }
    }

    prompt += "\n\nGive your honest, informed take. Stay on this ONE article — do not pivot to a different topic. Cite specific facts (numbers, names) from the article. Read at least one direct quote verbatim if quotes were provided. Build a sustained 6 to 10 sentence argument with a clear thesis, evidence, and conclusion.";

    await this._generateSegment(prompt, "news_reaction", { topic: headline.title });
  }

  async _monologueSegment(promptPrefix) {
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

    const prompt = `${promptPrefix} ${topic}. Really get into it — this is your soapbox moment. Build the argument across 6 to 10 sentences. Stay on THIS topic — do not pivot. Be specific with examples, names, and facts.`;

    this.broadcast({ type: "segment_info", segmentType: "monologue", topic });

    await this._generateSegment(prompt, "monologue", { topic });
  }

  async _fillerSegment() {
    const prompt = pickFillerPrompt();
    this.broadcast({ type: "segment_info", segmentType: "filler" });
    await this._generateSegment(prompt, "filler", { topic: prompt.slice(0, 60) });
  }

  /**
   * Core method: build messages with show memory + system prompt + user prompt,
   * stream from Ollama, process sentences, broadcast to clients,
   * then summarize this segment and append to show memory.
   *
   * @param {string} userPrompt - The segment-specific prompt
   * @param {string} segmentType - "news_reaction" | "monologue" | "viewer_qa" | "filler"
   * @param {{topic?: string}} [meta] - Metadata used for show memory
   */
  async _generateSegment(userPrompt, segmentType, meta = {}) {
    this.segmentCount++;
    const segNum = this.segmentCount;
    const t0 = Date.now();

    // Build the system prompt with show memory injected (lets Liberty do callbacks)
    const memoryBlock = this._buildMemoryBlock();
    const systemContent = memoryBlock
      ? `${PERSONALITY.systemPrompt}\n\n${memoryBlock}`
      : PERSONALITY.systemPrompt;

    const messages = [
      { role: "system", content: systemContent },
      { role: "user", content: userPrompt },
    ];

    console.log(`[segment #${segNum}] [${segmentType}] Starting — prompt: "${userPrompt.slice(0, 80)}..." (memory: ${this.showMemory.length})`);

    // Stream from Ollama, process sentences, broadcast
    let fullResponse = "";
    let sentenceBuffer = "";
    let sentenceCount = 0;

    this.broadcast({ type: "generating_start", prompt: userPrompt.slice(0, 100) });

    for await (const chunk of streamChat(messages)) {
      fullResponse += chunk;
      sentenceBuffer += chunk;

      // Send sentences as they complete (split on sentence-ending punctuation)
      const sentences = splitSentences(sentenceBuffer);
      if (sentences.length > 1) {
        for (let i = 0; i < sentences.length - 1; i++) {
          const raw = sentences[i].trim();
          if (raw) {
            sentenceCount++;
            const processed = processSentence(raw);
            if (processed.text) {
              console.log(`[segment #${segNum}] Sentence ${sentenceCount} [${processed.mood}]: "${processed.text.slice(0, 60)}..."`);
              this._sendSentence(processed.text, processed.mood, processed.gesture);
            }
          }
        }
        sentenceBuffer = sentences[sentences.length - 1];
      }
    }

    // Flush remaining text
    if (sentenceBuffer.trim()) {
      sentenceCount++;
      const processed = processSentence(sentenceBuffer.trim());
      if (processed.text) {
        console.log(`[segment #${segNum}] Sentence ${sentenceCount} (final) [${processed.mood}]: "${processed.text.slice(0, 60)}..."`);
        this._sendSentence(processed.text, processed.mood, processed.gesture);
      }
    }

    const elapsed = Date.now() - t0;
    console.log(`[segment #${segNum}] Done — ${sentenceCount} sentences, ${fullResponse.length} chars in ${elapsed}ms`);

    // Update show memory with this segment so future segments can reference it.
    // Cheap one-line summary: first ~140 chars of cleaned text.
    this._appendMemory(segmentType, meta.topic, fullResponse);

    this.broadcast({ type: "generating_done" });
  }

  /**
   * Build the "show memory" system-prompt addendum so Liberty knows what
   * she has been talking about. Empty string when no memory yet.
   */
  _buildMemoryBlock() {
    if (this.showMemory.length === 0) return "";
    const lines = this.showMemory.map((m, i) => {
      const idx = this.showMemory.length - i; // most recent = 1
      const ago = idx === 1 ? "Just now" : `${idx} segments ago`;
      const t = m.topic ? ` (${m.topic})` : "";
      return `- ${ago} [${m.type}]${t}: ${m.summary}`;
    });
    return [
      "SHOW MEMORY — what you have already covered earlier in this broadcast:",
      ...lines,
      "",
      "Use this memory only for natural callbacks (e.g., 'Earlier I was ranting about X, well now look at this...'). Do NOT repeat the same arguments. Do NOT pivot to those past topics — stay on the new prompt below.",
    ].join("\n");
  }

  /**
   * Append a segment summary to rolling show memory.
   * Strips emojis, contractions are already handled in the cleaned response,
   * we just keep a compact one-line summary.
   */
  _appendMemory(segmentType, topic, fullResponse) {
    // Strip emojis and normalize whitespace for a compact summary
    const cleaned = (fullResponse || "")
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    // Take the first sentence-ish chunk up to ~160 chars as the summary
    const summary = cleaned.length > 160
      ? cleaned.slice(0, 160).replace(/\s+\S*$/, "") + "…"
      : cleaned;

    this.showMemory.push({
      type: segmentType,
      topic: topic || null,
      summary,
      timestamp: Date.now(),
    });

    // Trim to max entries
    while (this.showMemory.length > this.maxMemoryEntries) {
      this.showMemory.shift();
    }
  }

  /**
   * Send a processed sentence to all clients.
   */
  _sendSentence(text, mood, gesture) {
    // Check for queue interruption
    if (this._interruptQueue) {
      this._interruptQueue = false;
      this.broadcast({ type: "interrupt" });
      console.log("[orchestrator] Sent interrupt to clients");
    }

    this.broadcast({
      type: "speak",
      text,
      mood: mood || "neutral",
      gesture: gesture || null,
    });
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

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if error is related to Ollama.
   */
  _isOllamaError(err) {
    const msg = err.message || "";
    return (
      msg.includes("Ollama") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("fetch") ||
      msg.includes("num_predict") ||
      msg.includes("model")
    );
  }

  /**
   * Attempt to revive Ollama by checking and potentially waiting.
   */
  async _reviveOllama() {
    for (let i = 0; i < 5; i++) {
      const status = await checkOllama();
      if (status.ok && status.available) {
        console.log(`[orchestrator] Ollama check passed after ${i + 1} attempts`);
        return true;
      }
      console.log(`[orchestrator] Waiting for Ollama (${i + 1}/5)...`);
      await this._sleep(5000);
    }
    return false;
  }
}

/**
 * Split text on sentence boundaries, keeping the delimiter with the sentence.
 * Handles emojis appearing after sentence-ending punctuation.
 */
function splitSentences(text) {
  // Split on . ! ? followed by optional emoji(s) and then a space or end
  return text.split(/(?<=[.!?](?:\s*[\p{Emoji_Presentation}\p{Extended_Pictographic}])*)\s+/u);
}
