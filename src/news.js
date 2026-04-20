// Liberty Live - News Feed
// Fetches headlines from RSS feeds to give the host something to talk about.

import Parser from "rss-parser";

const parser = new Parser({
  timeout: 10000,
  headers: { "User-Agent": "LibertyLive/0.1" },
});

// News sources — mix of mainstream and libertarian-leaning
const FEEDS = [
  { name: "Reuters Top News", url: "https://feeds.reuters.com/reuters/topNews" },
  { name: "AP News", url: "https://rss.app/feeds/v1.1/tsNqDYocVzHhxsn6.xml" },
  { name: "Reason Magazine", url: "https://reason.com/feed/" },
  { name: "Cato Institute", url: "https://www.cato.org/rss/recent-opeds" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "Hacker News", url: "https://hnrss.org/frontpage" },
];

// Track which headlines we've already covered
const coveredHeadlines = new Set();
const MAX_COVERED = 200;

/**
 * Fetch fresh headlines from all configured RSS feeds.
 * Returns only headlines we haven't covered yet.
 *
 * @param {number} limit - Max headlines to return
 * @returns {Array<{title: string, link: string, source: string, snippet: string}>}
 */
export async function fetchHeadlines(limit = 10) {
  const headlines = [];

  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        return (parsed.items || []).slice(0, 5).map((item) => ({
          title: item.title?.trim() || "",
          link: item.link || "",
          source: feed.name,
          snippet: stripHtml(item.contentSnippet || item.content || "").slice(0, 300),
          date: item.pubDate || item.isoDate || "",
        }));
      } catch {
        return [];
      }
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      headlines.push(...result.value);
    }
  }

  // Filter out already-covered headlines and empty titles
  const fresh = headlines.filter((h) => {
    if (!h.title) return false;
    const key = h.title.toLowerCase().slice(0, 60);
    if (coveredHeadlines.has(key)) return false;
    return true;
  });

  // Shuffle for variety
  shuffle(fresh);

  return fresh.slice(0, limit);
}

/**
 * Mark a headline as covered so we don't repeat it.
 */
export function markCovered(headline) {
  const key = headline.title.toLowerCase().slice(0, 60);
  coveredHeadlines.add(key);

  // Evict oldest entries if the set gets too large
  if (coveredHeadlines.size > MAX_COVERED) {
    const first = coveredHeadlines.values().next().value;
    coveredHeadlines.delete(first);
  }
}

/**
 * Get the count of available fresh headlines without fetching.
 */
export function getCoveredCount() {
  return coveredHeadlines.size;
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
