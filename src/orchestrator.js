// Liberty Live - Show Orchestrator
// The main loop that drives the 24/7 broadcast.
// Each segment gets fresh context — no carryover from previous topics.
// Researches articles (full text + web search) before reacting.

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
    this.segmentPause = 3000; // ms pause between segments
    this.segmentCount = 0;
    
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
      await this._generateSegment(prompt, "viewer_qa");
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
          await this._generateSegment(prompt, "viewer_qa");
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

  /**
   * News segment: fetch article, research it, then react.
   * Each article gets FRESH context — no carryover from previous segments.
   */
  async _newsSegment() {
    await this._refreshHeadlines();

    if (this.headlineCache.length === 0) {
      await this._fillerSegment();
      return;
    }

    const headline = this.headlineCache.shift();
    markCovered(headline);

    this.broadcast({
      type: "segment_info",
      segmentType: "news_reaction",
      headline: headline.title,
      source: headline.source,
    });

    // Research: fetch full article + web search in parallel
    const research = await researchHeadline(headline);

    // Build a rich prompt with all the research context
    let prompt = `ARTICLE TO REACT TO:\nHeadline: "${headline.title}"\nSource: ${headline.source}`;

    if (research.articleText) {
      prompt += `\n\nFull article text:\n${research.articleText}`;
    } else if (headline.snippet) {
      prompt += `\n\nSummary: ${headline.snippet}`;
    }

    if (research.searchResults.length > 0) {
      prompt += "\n\nADDITIONAL CONTEXT FROM WEB SEARCH:";
      for (const result of research.searchResults) {
        prompt += `\n- ${result.title}: ${result.snippet}`;
      }
    }

    prompt += "\n\nGive your honest, informed take on this. Reference specific facts from the article. If the web search results contradict the article, call it out. Be specific, not generic.";

    await this._generateSegment(prompt, "news_reaction");
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

    const prompt = `${promptPrefix} ${topic}. Really get into it — this is your soapbox moment. Be specific with examples and facts.`;

    this.broadcast({ type: "segment_info", segmentType: "monologue", topic });

    await this._generateSegment(prompt, "monologue");
  }

  async _fillerSegment() {
    const prompt = pickFillerPrompt();
    this.broadcast({ type: "segment_info", segmentType: "filler" });
    await this._generateSegment(prompt, "filler");
  }

  /**
   * Core method: send prompt to Ollama with FRESH context, stream response,
   * parse expressions, broadcast to clients.
   *
   * Each call builds messages from scratch — system prompt + user prompt only.
   * No conversation history carryover between segments.
   */
  async _generateSegment(userPrompt, segmentType) {
    this.segmentCount++;
    const segNum = this.segmentCount;
    const t0 = Date.now();

    // FRESH context every segment — system prompt + this prompt only
    const messages = [
      { role: "system", content: PERSONALITY.systemPrompt },
      { role: "user", content: userPrompt },
    ];

    console.log(`[segment #${segNum}] [${segmentType}] Starting — prompt: "${userPrompt.slice(0, 80)}..."`);

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

    this.broadcast({ type: "generating_done" });
  }

  /**
   * Send a processed sentence to all clients.
   */
  _sendSentence(text, mood, gesture) {
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
