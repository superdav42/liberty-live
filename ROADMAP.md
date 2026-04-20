# Roadmap - Liberty Live

## Phase 1: Core Polish (MVP → Watchable)

- [ ] **Custom avatar** — Create a quirky, non-realistic character in VRoid Studio. Export VRM, convert to GLB via Blender with ARKit + Oculus blend shapes. Replace the placeholder brunette avatar.
- [ ] **Speech interruption** — Allow new segments to interrupt the current speech queue instead of waiting for it to drain. Critical for responsive viewer interaction.
- [ ] **Gesture integration** — Have the LLM emit gesture/pose hints (via Ollama tool calling or keyword detection) that trigger TalkingHead hand gestures (`thumbup`, `shrug`, `index`, `side`) and Mixamo animations.
- [ ] **Background scenes** — Cycle through background images/videos (studio set, cityscape, etc.) to keep the visual interesting. TalkingHead supports background views natively.
- [ ] **Thinking animations** — Play idle animations (pacing, looking around, tapping chin) while waiting for Ollama to generate, so there's no dead stare during inference.
- [ ] **Error recovery** — Auto-restart the show loop on Ollama connection failures, HeadTTS crashes, or WebSocket disconnects. The show must never stop.

## Phase 2: Audience Interaction

- [ ] **YouTube Live Chat integration** — Poll YouTube Data API v3 `liveChatMessages.list` for viewer comments. Filter for interesting/engaging ones, queue them for Liberty to read and respond to.
- [ ] **Comment display overlay** — Show the viewer's name and comment on screen when Liberty reads it, talk-show style.
- [ ] **Viewer memory** — Track frequent commenters in a local SQLite DB. Let Liberty reference past interactions ("Oh, you're back again!").
- [ ] **Superchat/donation reactions** — Detect and prioritize YouTube superchats with special reactions and thank-yous.
- [ ] **Twitch chat support** — Add Twitch IRC integration as an alternative to YouTube.
- [ ] **Poll/vote segments** — Let viewers vote on topics for Liberty to rant about next.

## Phase 3: Content Depth

- [ ] **Article summarization** — Fetch full article text (not just headlines) and summarize via Ollama before reacting, for more informed takes.
- [ ] **Topic memory** — Persist covered topics across restarts. Avoid repeating the same stories. Track the show's "editorial calendar."
- [ ] **Debate mode** — Liberty argues both sides of an issue, switching avatar mood/pose between "positions."
- [ ] **Guest characters** — Load a second avatar for "caller" segments or debates. Use a different TTS voice for the guest.
- [ ] **Show segments with intros** — Add jingle audio and title cards between segments ("And now, Liberty's Hot Take of the Hour...").
- [ ] **Scheduled deep dives** — Pre-schedule longer analysis segments on specific topics at certain times of day.
- [ ] **Trending topic detection** — Scrape Reddit, X/Twitter, or Google Trends to find what's actually trending right now, not just what's in RSS.

## Phase 4: Production Quality

- [ ] **Headless streaming pipeline** — `xvfb` + Chromium + `ffmpeg -f x11grab` for 24/7 unattended YouTube RTMP streaming without OBS or a GUI.
- [ ] **Stream health monitoring** — Watchdog that checks RTMP connection, frame rate, audio levels, and auto-restarts on failure.
- [ ] **OBS WebSocket integration** — Control OBS scenes, transitions, and overlays programmatically from the orchestrator.
- [ ] **News ticker** — Scrolling lower-third with recent headlines, independent of what Liberty is currently discussing.
- [ ] **Multiple camera angles** — Switch between TalkingHead camera views (full, mid, upper, head) based on segment type.
- [ ] **Audio post-processing** — Add subtle room reverb, compression, and EQ to the TTS output for broadcast polish. TalkingHead supports impulse response convolution.

## Phase 5: Intelligence

- [ ] **RAG knowledge base** — Index libertarian literature, economics texts, and historical events into a vector DB. Let Liberty cite sources accurately.
- [ ] **Fact-checking pipeline** — Before broadcasting a claim, cross-reference against a knowledge base or search API. Add corrections or caveats.
- [ ] **Sentiment-aware segment pacing** — If the last 3 segments were angry rants, schedule a lighter segment next. Vary the emotional arc.
- [ ] **Show analytics** — Log segment types, viewer engagement (chat volume), and mood distribution. Generate a daily show summary.
- [ ] **Multi-model support** — Use a fast small model (3B) for quick viewer responses and a larger model (70B) for deep-dive monologues.
- [ ] **Content moderation** — Filter viewer comments for harassment/spam before Liberty reads them. Flag potentially defamatory generated content.

## Phase 6: Multi-Platform

- [ ] **Podcast export** — Record the audio stream and auto-publish as a daily podcast (RSS + MP3).
- [ ] **Clip generation** — Detect the most "spicy" segments (high mood variance) and auto-cut highlight clips for social media.
- [ ] **Twitter/X bot** — Post Liberty's hottest takes as tweets, linking back to the live stream.
- [ ] **Web viewer** — Host the avatar + live audio on a standalone website (no YouTube dependency).
- [ ] **Multi-language** — When HeadTTS/Kokoro adds new languages, offer Liberty in Spanish, French, etc. with localized personality tweaks.

## Technical Debt

- [ ] Extract frontend JS from inline `<script>` in `index.html` into separate module files
- [ ] Add a proper test suite (Vitest or similar)
- [ ] Add a configuration file (`.env` or `config.json`) instead of scattered env vars and constants
- [ ] Bundle TalkingHead + Three.js locally instead of CDN dependency for offline capability
- [ ] Add health check endpoints for HeadTTS and stream status
- [ ] TypeScript migration (if the codebase grows substantially)
