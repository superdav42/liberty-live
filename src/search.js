// Liberty Live - Web Search
// Searches the web via DuckDuckGo for research and fact-checking context.

const DDG_URL = "https://html.duckduckgo.com/html/";
const FETCH_TIMEOUT = 8000; // ms

/**
 * Search DuckDuckGo and return top results with snippets.
 * Uses the HTML lite interface (no API key needed).
 *
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results to return (default 5)
 * @returns {Promise<Array<{title: string, snippet: string, url: string}>>}
 */
export async function searchWeb(query, maxResults = 5) {
  try {
    const params = new URLSearchParams({ q: query });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const resp = await fetch(`${DDG_URL}?${params}`, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LibertyLive/1.0)",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      console.warn(`[search] DDG returned ${resp.status}`);
      return [];
    }

    const html = await resp.text();
    return parseResults(html, maxResults);
  } catch (err) {
    console.warn(`[search] Failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch a web page and extract its readable text content.
 * Best-effort extraction — works well for news articles.
 *
 * @param {string} url - Page URL to fetch
 * @param {number} maxChars - Maximum characters to return (default 3000)
 * @returns {Promise<string>} Extracted text or empty string on failure
 */
export async function fetchPageText(url, maxChars = 3000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LibertyLive/1.0; +research)",
        "Accept": "text/html",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!resp.ok) return "";

    const html = await resp.text();
    return extractArticleText(html, maxChars);
  } catch (err) {
    console.warn(`[search] Failed to fetch ${url}: ${err.message}`);
    return "";
  }
}

// --- Internal helpers ---

/**
 * Parse DuckDuckGo HTML results page into structured results.
 */
function parseResults(html, max) {
  const results = [];

  // DDG HTML results are in <div class="result"> blocks
  // Each has <a class="result__a"> for title/url and <a class="result__snippet"> for snippet
  const resultBlocks = html.split(/class="result\s/);

  for (let i = 1; i < resultBlocks.length && results.length < max; i++) {
    const block = resultBlocks[i];

    // Extract URL from result__a href
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    // Extract title text
    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
    // Extract snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+)/);

    if (urlMatch && titleMatch) {
      let url = urlMatch[1];
      // DDG proxies URLs through a redirect — extract the real URL
      const realUrl = url.match(/uddg=([^&]+)/);
      if (realUrl) {
        url = decodeURIComponent(realUrl[1]);
      }

      results.push({
        title: decodeEntities(titleMatch[1]).trim(),
        snippet: snippetMatch ? decodeEntities(snippetMatch[1]).trim() : "",
        url,
      });
    }
  }

  return results;
}

/**
 * Extract readable text from HTML, focusing on article content.
 */
function extractArticleText(html, maxChars) {
  // Try to find article/main content area first
  let content = "";

  // Look for <article>, <main>, or common content divs
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  if (articleMatch) {
    content = articleMatch[1];
  } else if (mainMatch) {
    content = mainMatch[1];
  } else {
    // Fall back to <body>
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    content = bodyMatch ? bodyMatch[1] : html;
  }

  // Strip HTML tags
  content = content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Decode HTML entities
  content = decodeEntities(content);

  return content.slice(0, maxChars);
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
