// Liberty Live - Ollama Client
// Streams chat completions from a local Ollama instance.

const OLLAMA_BASE = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:8b";

/**
 * Stream a chat completion from Ollama.
 * Yields text chunks as they arrive.
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
    options: {
      temperature: 0.9,
      top_p: 0.95,
      repeat_penalty: 1.1,
      num_predict: 300,
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

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        if (data.message?.content) {
          yield data.message.content;
        }
      } catch {
        // skip malformed lines
      }
    }
  }
}

/**
 * Non-streaming chat completion (for short responses).
 *
 * @param {Array} messages - Chat messages array
 * @param {object} options - Optional Ollama parameters
 * @returns {string} Full response text
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
      num_predict: 300,
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
