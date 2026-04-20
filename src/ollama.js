// Liberty Live - Ollama Client
// Streams chat completions from a local Ollama instance.

const OLLAMA_BASE = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b-16k";

/**
 * Stream a chat completion from Ollama.
 * Yields text chunks as they arrive (thinking tokens are skipped).
 *
 * @param {Array} messages - Chat messages array [{role, content}, ...]
 * @param {object} options - Optional Ollama parameters (temperature, etc.)
 * @yields {string} Text chunks from the model
 */
export async function* streamChat(messages, options = {}) {
  const body = {
    model: OLLAMA_MODEL,
    messages,
    stream: true,
    // Let thinking models reason deeply — thinking tokens stay hidden,
    // only visible content is yielded to callers.
    options: {
      temperature: 0.9,
      top_p: 0.95,
      repeat_penalty: 1.1,
      num_predict: 2048,
      ...options,
    },
  };

  const t0 = Date.now();
  console.log(`[ollama] Requesting ${OLLAMA_MODEL} (num_predict: ${body.options.num_predict})`);

  const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`[ollama] HTTP ${response.status}: ${errBody}`);
    throw new Error(`Ollama error ${response.status}: ${errBody}`);
  }

  const ttfb = Date.now() - t0;
  console.log(`[ollama] Connected — TTFB: ${ttfb}ms`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;
  let totalChars = 0;
  let loggedFirstChunk = false;
  let thinkingChunks = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Ollama streams newline-delimited JSON
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);

        // Log first chunk structure once
        if (!loggedFirstChunk && !data.done) {
          loggedFirstChunk = true;
          const fields = Object.keys(data.message || {}).join(", ");
          console.log(`[ollama] Response fields: { ${fields} }`);
        }

        // Track thinking-only chunks (content empty, thinking present)
        if (!data.done && !data.message?.content && data.message?.thinking) {
          thinkingChunks++;
        }

        if (data.message?.content) {
          // Log transition from thinking to content
          if (chunkCount === 0 && thinkingChunks > 0) {
            const thinkSec = ((Date.now() - t0 - ttfb) / 1000).toFixed(1);
            console.log(`[ollama] Thinking: ${thinkingChunks} tokens (${thinkSec}s) before first content`);
          }
          chunkCount++;
          totalChars += data.message.content.length;
          yield data.message.content;
        }

        // Log eval stats from the final message
        if (data.done && data.eval_count) {
          const elapsed = Date.now() - t0;
          const tps = (data.eval_count / (data.eval_duration / 1e9)).toFixed(1);
          console.log(`[ollama] Done — ${data.eval_count} tokens in ${elapsed}ms (${tps} tok/s, think: ${thinkingChunks}, content: ${chunkCount} chunks/${totalChars} chars)`);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  // Fallback log if Ollama didn't include eval stats
  if (chunkCount === 0) {
    const elapsed = Date.now() - t0;
    console.warn(`[ollama] WARNING: 0 content tokens yielded after ${elapsed}ms (${thinkingChunks} thinking tokens). Model may have exhausted num_predict on thinking.`);
  }
}

/**
 * Non-streaming chat completion (for short responses).
 */
export async function chat(messages, options = {}) {
  const body = {
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    options: {
      temperature: 0.9,
      top_p: 0.95,
      repeat_penalty: 1.1,
      num_predict: 2048,
      ...options,
    },
  };

  const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Ollama error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.message?.content || "";
}

/**
 * Check if Ollama is reachable and the model is available.
 */
export async function checkOllama() {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };

    const data = await resp.json();
    const models = data.models?.map((m) => m.name) || [];
    const modelBase = OLLAMA_MODEL.split(":")[0];
    const hasModel = models.some((m) => m.startsWith(modelBase));

    return {
      ok: true,
      model: OLLAMA_MODEL,
      available: hasModel,
      models,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
