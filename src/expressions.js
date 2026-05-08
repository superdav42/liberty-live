// Liberty Live - Expression Engine
// Parses emoji markers from LLM output into avatar moods/gestures,
// and expands contractions for cleaner TTS pronunciation.

/**
 * Emoji → TalkingHead mood mapping.
 * The LLM inserts these between sentences to direct the avatar's expression.
 */
const EMOJI_MOOD = {
  // Angry
  "😡": "angry", "🤬": "angry", "😤": "angry", "💢": "angry",
  // Happy
  "😊": "happy", "😄": "happy", "😁": "happy", "🤣": "happy",
  "😂": "happy", "🎉": "happy", "👍": "happy", "💪": "happy",
  // Sad
  "😢": "sad", "😭": "sad", "💔": "sad", "😞": "sad",
  // Fear / shock
  "😱": "fear", "😨": "fear", "🤯": "fear", "😳": "fear",
  // Disgust
  "🤢": "disgust", "🤮": "disgust", "🙄": "disgust",
  // Love / admiration
  "❤️": "love", "😍": "love", "🥰": "love", "🫡": "love",
};

/**
 * Emoji → gesture hint (for future full-body avatar support).
 * Currently used as metadata — TalkingHead face-only avatars
 * express these through intensified mood.
 */
const EMOJI_GESTURE = {
  "🫵": "point",    // pointing at camera / audience
  "✊": "fist",     // fist pump, emphasis
  "👏": "clap",     // applause
  "🤷": "shrug",    // shrug
  "🤔": "think",    // thinking, chin stroke
  "👋": "wave",     // wave
  "☝️": "raise",    // raise finger, "listen up"
};

// Build a regex that matches any mapped emoji
const ALL_EMOJIS = [
  ...Object.keys(EMOJI_MOOD),
  ...Object.keys(EMOJI_GESTURE),
];
// Escape for regex and join — match one or more consecutive emojis
const EMOJI_PATTERN = new RegExp(
  `(${ALL_EMOJIS.map(e => e.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|")})+`,
  "g"
);

/**
 * Parse a sentence that may contain trailing emoji markers.
 * Returns the clean text and detected mood/gesture.
 *
 * @param {string} text - Raw sentence from LLM (may have emojis)
 * @returns {{ text: string, mood: string, gesture: string|null }}
 */
export function parseExpression(text) {
  let mood = "neutral";
  let gesture = null;

  // Extract all emojis from the text
  const emojis = text.match(EMOJI_PATTERN);
  if (emojis) {
    const allFound = emojis.join("");
    // Check each character/emoji for mood or gesture
    for (const [emoji, m] of Object.entries(EMOJI_MOOD)) {
      if (allFound.includes(emoji)) {
        mood = m;
      }
    }
    for (const [emoji, g] of Object.entries(EMOJI_GESTURE)) {
      if (allFound.includes(emoji)) {
        gesture = g;
      }
    }
  }

  // Strip emojis and clean up whitespace
  const cleanText = text.replace(EMOJI_PATTERN, "").replace(/\s{2,}/g, " ").trim();

  return { text: cleanText, mood, gesture };
}

/**
 * Common English contractions → expanded forms for TTS clarity.
 * Ordered longest-first so "you're" matches before "you".
 */
const CONTRACTIONS = [
  // Negative contractions (must come before possessive forms)
  [/\bcan'?t\b/gi, "cannot"],
  [/\bwon'?t\b/gi, "will not"],
  [/\bshan'?t\b/gi, "shall not"],
  [/\bain'?t\b/gi, "is not"],
  [/\bisn'?t\b/gi, "is not"],
  [/\baren'?t\b/gi, "are not"],
  [/\bwasn'?t\b/gi, "was not"],
  [/\bweren'?t\b/gi, "were not"],
  [/\bhasn'?t\b/gi, "has not"],
  [/\bhaven'?t\b/gi, "have not"],
  [/\bhadn'?t\b/gi, "had not"],
  [/\bdon'?t\b/gi, "do not"],
  [/\bdoesn'?t\b/gi, "does not"],
  [/\bdidn'?t\b/gi, "did not"],
  [/\bcouldn'?t\b/gi, "could not"],
  [/\bwouldn'?t\b/gi, "would not"],
  [/\bshouldn'?t\b/gi, "should not"],
  [/\bmightn'?t\b/gi, "might not"],
  [/\bmustn'?t\b/gi, "must not"],
  [/\bneedn'?t\b/gi, "need not"],

  // Pronoun contractions
  [/\bI'?m\b/g, "I am"],
  [/\bI'?ve\b/g, "I have"],
  [/\bI'?ll\b/g, "I will"],
  [/\bI'?d\b/g, "I would"],
  [/\byou'?re\b/gi, "you are"],
  [/\byou'?ve\b/gi, "you have"],
  [/\byou'?ll\b/gi, "you will"],
  [/\byou'?d\b/gi, "you would"],
  [/\bhe'?s\b/gi, "he is"],
  [/\bshe'?s\b/gi, "she is"],
  [/\bit'?s\b/gi, "it is"],
  [/\bwe'?re\b/gi, "we are"],
  [/\bwe'?ve\b/gi, "we have"],
  [/\bwe'?ll\b/gi, "we will"],
  [/\bwe'?d\b/gi, "we would"],
  [/\bthey'?re\b/gi, "they are"],
  [/\bthey'?ve\b/gi, "they have"],
  [/\bthey'?ll\b/gi, "they will"],
  [/\bthey'?d\b/gi, "they would"],

  // Common contractions
  [/\bthat'?s\b/gi, "that is"],
  [/\bwho'?s\b/gi, "who is"],
  [/\bwhat'?s\b/gi, "what is"],
  [/\bwhere'?s\b/gi, "where is"],
  [/\bwhen'?s\b/gi, "when is"],
  [/\bwhy'?s\b/gi, "why is"],
  [/\bhow'?s\b/gi, "how is"],
  [/\bthere'?s\b/gi, "there is"],
  [/\bhere'?s\b/gi, "here is"],
  [/\blet'?s\b/gi, "let us"],
  [/\bwho'?d\b/gi, "who would"],
  [/\bwho'?ll\b/gi, "who will"],
  [/\bthat'?ll\b/gi, "that will"],
  [/\bthat'?d\b/gi, "that would"],
];

/**
 * Expand contractions for TTS pronunciation.
 * "I'm gonna tell you" → "I am gonna tell you"
 *
 * @param {string} text
 * @returns {string}
 */
export function expandContractions(text) {
  let result = text;
  for (const [pattern, replacement] of CONTRACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Acronyms that should be pronounced letter-by-letter by TTS.
 * We add periods between letters so the TTS engine spells them out
 * instead of trying to pronounce them as words. We deliberately exclude
 * acronyms that are read as words (NATO, NASA, OPEC, FEMA, AIDS, etc.).
 *
 * Order matters: longer acronyms first so we do not partially match.
 */
const PRONOUNCED_LETTER_ACRONYMS = [
  // Country codes — most common, do these first
  "USA", "US", "UK", "EU", "UN",
  // Three-letter agencies (read letter-by-letter)
  "FBI", "CIA", "NSA", "DEA", "DOJ", "DHS", "ATF", "TSA",
  "IRS", "SEC", "FTC", "FCC", "FDA", "EPA", "DOD", "DOE",
  "GAO", "OMB", "CDC", "WHO", "ICC", "BLM", "DNC", "RNC",
  "GOP", "PBS", "BBC", "CNN", "NPR", "FOX", "MSM",
  "NYT", "WSJ", "WaPo", "AP",
  // Tech / regulatory
  "AI", "ML", "VPN", "DNS", "DRM", "EFF", "ACLU", "NRA", "NEA",
  // Programs
  "TANF", "EBT", "SNAP", "SSA", "SSI", "VA", "HUD",
  // Surveillance / law
  "FISA", "PATRIOT", "NDAA",
  // Markets / economics
  "GDP", "CPI", "PCE", "BLS", "CBO", "Fed", "FOMC", "ECB",
];

// Pre-compute regexes once: each one matches the bare acronym at word boundaries,
// not when already periodized. We exclude an already-periodized form (e.g.,
// "U.S.") and lowercase forms intentionally (don't match "us" the pronoun).
const ACRONYM_PATTERNS = PRONOUNCED_LETTER_ACRONYMS
  .filter((a) => a.length >= 2 && /^[A-Z]+$/.test(a))
  .sort((a, b) => b.length - a.length) // longest first
  .map((a) => ({
    acronym: a,
    // Match the acronym as a standalone word, in any case (e.g. US, U.S already
    // has periods so we match the bareword only). We allow it to be at start/end
    // of string and surrounded by non-alphanumerics. The negative lookbehind/ahead
    // for "." prevents re-periodizing already-periodized acronyms like "U.S.".
    regex: new RegExp(`(?<![A-Za-z0-9.])${a}(?![A-Za-z0-9.])`, "g"),
    // The replacement: letters separated by periods, with a trailing period
    replacement: a.split("").join(".") + ".",
  }));

/**
 * Normalize acronyms for TTS pronunciation.
 * "the FBI and IRS in the US" → "the F.B.I. and I.R.S. in the U.S."
 *
 * Skips already-periodized forms ("U.S." stays as "U.S.").
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeAcronyms(text) {
  let result = text;
  for (const { regex, replacement } of ACRONYM_PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Strip markdown formatting that TTS shouldn't pronounce.
 * Removes **bold**, *italic*, and other markup.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text) {
  return text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")  // **bold** or *italic*
    .replace(/_([^_]+)_/g, "$1")                 // _italic_
    .replace(/`([^`]+)`/g, "$1")                 // `code`
    .replace(/#{1,6}\s/g, "")                     // # headings
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")     // [links](url)
    .trim();
}

/**
 * Full pipeline: parse expression, strip markdown, expand contractions,
 * normalize acronyms (US → U.S., FBI → F.B.I., etc).
 * Used by the orchestrator before broadcasting to clients.
 *
 * @param {string} rawText - Raw LLM output sentence
 * @returns {{ text: string, mood: string, gesture: string|null }}
 */
export function processSentence(rawText) {
  const expr = parseExpression(rawText);
  const clean = stripMarkdown(expr.text);
  const expanded = expandContractions(clean);
  const normalized = normalizeAcronyms(expanded);
  return {
    text: normalized,
    mood: expr.mood,
    gesture: expr.gesture,
  };
}
