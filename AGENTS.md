# AI Agent Instructions - Liberty Live

## Project Overview

Liberty Live is a 24/7 AI-powered live streaming talk show. A 3D avatar ("Liberty") reacts to current events and viewer comments, powered entirely by local infrastructure: Ollama for LLM inference, HeadTTS/Kokoro for neural text-to-speech, and TalkingHead for WebGL avatar rendering with lip-sync.

The project is a Node.js application (ESM modules, no TypeScript, no build step).

## Architecture

```
src/server.js        → Express HTTP + WebSocket server (port 3333)
src/start.js         → Launcher: spawns HeadTTS + server as child processes
src/orchestrator.js  → Show loop: picks segments, streams Ollama → clients
src/ollama.js        → Ollama REST client with streaming generator
src/news.js          → RSS feed fetcher (rss-parser)
src/personality.js   → System prompt, mood detection, segment config

public/index.html    → Frontend: TalkingHead avatar + HeadTTS integration + controls
public/css/style.css → Broadcast-style dark UI

headtts/             → Cloned HeadTTS repo (gitignored, installed via `npm run setup`)
```

## Key Design Decisions

- **No build step.** The frontend uses native ES modules and import maps. TalkingHead and Three.js load from CDN. Keep it this way — simplicity is a feature.
- **No TypeScript.** Plain JS with JSDoc comments. The codebase is small enough that types add friction without proportional value.
- **Sentence-level streaming.** The orchestrator streams Ollama output and splits on sentence boundaries before sending to TTS. This gives low latency (the avatar starts speaking before the full response is generated) without cutting mid-word.
- **HeadTTS is optional.** The frontend gracefully degrades to subtitle-only mode if HeadTTS isn't running on port 8882. Never make HeadTTS a hard dependency.
- **Mood detection is keyword-based.** `personality.js:detectMood()` maps keywords to TalkingHead mood strings. This is intentionally simple — it runs on every sentence and doesn't need an LLM call.

## Data Flow

1. Orchestrator picks a segment type (weighted random: news 40%, viewer Q&A 25%, monologue 20%, filler 15%)
2. For news segments, `news.js` fetches RSS headlines and tracks which have been covered
3. Orchestrator builds messages array: `[system prompt, ...conversation history, user prompt]`
4. `ollama.js:streamChat()` yields text chunks from Ollama's streaming API
5. Orchestrator accumulates chunks, splits on sentence boundaries, broadcasts `{type: "speak", text, mood}` via WebSocket
6. Frontend receives `speak` messages, queues them, sends each to HeadTTS REST API (`/v1/synthesize`)
7. HeadTTS returns audio (base64 WAV) + viseme timing data
8. Frontend passes audio+visemes to TalkingHead's `speakAudio()` for lip-synced playback

## WebSocket Protocol

Server → Client messages:

| type | fields | description |
|---|---|---|
| `speak` | `text`, `mood` | Sentence to speak with avatar mood |
| `show_start` | | Show loop has started |
| `show_stop` | | Show loop has stopped |
| `segment_info` | `segmentType`, `headline?`, `source?`, `topic?` | Current segment metadata |
| `generating_start` | `prompt` | LLM generation started |
| `generating_done` | | LLM generation finished |
| `status` | `running`, `segments` | Current show state |

Client → Server messages:

| type | fields | description |
|---|---|---|
| `comment` | `name`, `comment` | Viewer comment to queue |

## External Dependencies

| Dependency | Role | Required | Port |
|---|---|---|---|
| **Ollama** | LLM inference | Yes | 11434 |
| **HeadTTS** | Kokoro neural TTS + visemes | No (graceful degradation) | 8882 |
| **TalkingHead** | 3D avatar rendering | Yes (loaded from CDN) | - |
| **Three.js** | WebGL 3D engine | Yes (loaded from CDN) | - |

## Working on This Project

### Running locally

```bash
npm run setup     # one-time: install deps + clone HeadTTS
npm start         # launches HeadTTS + show server
npm run dev       # server only with --watch (no HeadTTS)
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3333` | Show server port |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama API URL |
| `OLLAMA_MODEL` | `gemma4:e4b` | Ollama model name (set in `~/.config/systemd/user/liberty-live.service`) |
| `AUTO_START` | unset | If `true`/`1`, the show loop starts automatically 5s after server boot |

### Production operations (systemd)

Two user-level systemd units run the stack on this host. They are enabled and persist across reboots.

| Unit | Role | Logs |
|---|---|---|
| `liberty-live.service` | Show server (Express + WebSocket + Ollama bridge + HeadTTS child) on port 3333 | `~/.aidevops/logs/liberty-live.log` |
| `liberty-stream.service` | YouTube streaming pipeline: Xvfb + Chrome (headless, software WebGL) + ffmpeg → RTMP | `~/.aidevops/logs/liberty-stream.log` |

`liberty-stream` has a soft `Wants=liberty-live.service` dependency; `stream.sh` preflights the show server before launching Chrome.

#### Starting

```bash
# Start both (show first, then stream)
systemctl --user start liberty-live.service
systemctl --user start liberty-stream.service

# Enable autostart on boot (already enabled on this host)
systemctl --user enable liberty-live.service liberty-stream.service
```

#### Stopping

```bash
# Stop the stream first so YouTube sees a clean disconnect, then the show
systemctl --user stop liberty-stream.service
systemctl --user stop liberty-live.service
```

`liberty-stream` uses `KillMode=mixed`, so stopping it terminates Xvfb, Chrome, ffmpeg, and the Chrome watchdog subshell together. Stopping `liberty-live` also kills the HeadTTS child it spawned.

#### Restarting

```bash
# After editing src/, public/, or .env — restart the show only
systemctl --user restart liberty-live.service

# After editing stream.sh or YouTube credentials — restart the stream only
systemctl --user restart liberty-stream.service

# Full pipeline reset (e.g. Chrome wedged, black-frame stream)
systemctl --user restart liberty-stream.service liberty-live.service
```

Both units have `Restart=on-failure`, so a Chrome crash or unhandled show-server exception triggers automatic recovery within ~10s. The Chrome watchdog inside `stream.sh` kills ffmpeg if Chrome dies, which trips `Restart=on-failure` on the whole stream unit.

#### Status and monitoring

```bash
# Quick health
systemctl --user status liberty-live.service liberty-stream.service
curl -s http://localhost:3333/api/health   # {running, model, clients}

# Live logs
journalctl --user -u liberty-live.service -f
journalctl --user -u liberty-stream.service -f

# ffmpeg progress (carriage-return delimited — convert before reading)
tr '\r' '\n' < /tmp/ffmpeg-stream.log | tail -20

# Render check (writes the X11 :99 display to PNG)
# stream.sh updates /tmp/stream-now.png periodically; >100KB means content, ~3KB means black
ls -l /tmp/stream-now.png
```

#### Reloading systemd units

After editing `~/.config/systemd/user/liberty-*.service`:

```bash
systemctl --user daemon-reload
systemctl --user restart liberty-live.service liberty-stream.service
```

#### Credentials

`.env` (gitignored) holds `YOUTUBE_RTMP_URL` and `YOUTUBE_STREAM_KEY`. After rotating the key in YouTube Studio, restart only `liberty-stream`. Never paste the key into logs, commits, or chat.

### Adding a new segment type

1. Add the type to `PERSONALITY.segmentTypes` in `src/personality.js` with a weight
2. Add a handler method `_yourSegment()` in `src/orchestrator.js`
3. Add the case to the switch in `_nextSegment()`

### Adding a new RSS feed

Add an entry to the `FEEDS` array in `src/news.js`. The fetcher handles failures per-feed gracefully.

### Changing the personality

Edit `src/personality.js`. The `systemPrompt` string is the entire personality — voice, opinions, speech patterns. The `moodKeywords` object maps words to TalkingHead moods (`neutral`, `happy`, `angry`, `sad`, `fear`, `disgust`, `love`).

### Changing the avatar

Drop a `.glb` file into `public/avatars/` and update the `head.showAvatar()` call in `public/index.html`. The avatar must have ARKit blend shapes (52) and Oculus visemes (15). See [TalkingHead avatar docs](https://github.com/met4citizen/TalkingHead#appendix-a-create-your-own-3d-avatar).

### Frontend conventions

- No framework — vanilla JS with ES modules
- TalkingHead and Three.js imported via CDN import map in `index.html`
- All show logic (speech queue, TTS calls, WebSocket handling) lives in the `<script type="module">` block in `index.html`
- CSS uses no preprocessor — plain CSS in `public/css/style.css`

## Testing

No test framework yet. To verify the system works:

1. Confirm Ollama is running: `curl http://localhost:11434/api/tags`
2. Start the app: `npm start`
3. Open `http://localhost:3333` in Chrome
4. Click "Start Show" — avatar should load and begin speaking
5. Check the show log panel for errors
6. Use the comment box to test viewer interaction

## Known Limitations

- HeadTTS Kokoro is English-only
- News fetching depends on RSS feed availability (feeds go down, change URLs)
- No persistent storage — conversation history and covered headlines reset on restart
- The speech queue doesn't handle interruptions (new segments wait for current speech to finish)
- TalkingHead CDN dependency means the avatar won't load offline

## See Also

- `ROADMAP.md` — planned features and improvements
- `README.md` — user-facing setup and usage docs
