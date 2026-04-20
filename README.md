# Liberty Live

24/7 AI-powered live streaming personality. A libertarian talk show host avatar that reacts to current events, responds to viewer comments, and never shuts up.

Runs entirely locally: Ollama (LLM) + HeadTTS/Kokoro (speech) + TalkingHead (3D avatar).

## Architecture

```
RSS Feeds ──┐
             ├──→ Orchestrator ──→ Ollama (LLM) ──→ HeadTTS (TTS) ──→ TalkingHead (Avatar)
Viewer Chat ─┘         │                                                      │
                       │                                                      ▼
                  Express Server ◄──── WebSocket ────► Browser (WebGL render)
                       │                                                      │
                       └──────── optional: OBS capture ──→ YouTube RTMP ──────┘
```

## Prerequisites

1. **Ollama** running locally with a model pulled:
   ```bash
   # Install from https://ollama.com
   ollama pull llama3.2:8b
   ollama serve  # if not already running
   ```

2. **HeadTTS** (optional but recommended for voice):
   ```bash
   git clone https://github.com/met4citizen/HeadTTS.git
   cd HeadTTS
   npm install
   npm start  # starts TTS server on port 8882
   ```
   Without HeadTTS, the avatar will display subtitles but won't speak aloud.

3. **Node.js** 20+

## Quick Start

```bash
git clone https://github.com/YOUR_USER/liberty-live.git
cd liberty-live
npm install
npm start
```

Open `http://localhost:3000` in Chrome/Edge (WebGL + WebGPU support needed).

Click **Start Show** and Liberty will start talking.

## How It Works

1. The **Orchestrator** picks a segment type (news reaction, monologue, viewer Q&A, filler)
2. It fetches fresh RSS headlines and builds a prompt with Liberty's personality
3. **Ollama** generates a response, streamed sentence-by-sentence
4. Each sentence is sent to **HeadTTS** (Kokoro neural TTS) for speech synthesis with viseme data
5. **TalkingHead** renders the 3D avatar with real-time lip-sync and facial expressions
6. Mood detection adjusts the avatar's expression (angry, happy, sad, etc.)

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `llama3.2:8b` | Model to use for generation |

### Custom Avatar

Drop a `.glb` file into `public/avatars/` and update the `url` in `public/index.html`:

```js
await head.showAvatar({
  url: "./avatars/your-avatar.glb",
  // ...
});
```

Compatible avatars: VRoid Studio exports (converted via Blender), Ready Player Me, Avaturn, MPFB.
See [TalkingHead docs](https://github.com/met4citizen/TalkingHead#appendix-a-create-your-own-3d-avatar) for avatar requirements.

### Personality

Edit `src/personality.js` to change:
- Name and speaking style
- Political leanings and worldview
- Segment types and weights
- Filler prompts for dead air

## Streaming to YouTube

1. Set up OBS Studio with a **Browser Source** pointing to `http://localhost:3000`
2. Configure OBS output to RTMP: `rtmp://a.rtmp.youtube.com/live2/YOUR_STREAM_KEY`
3. Start streaming in OBS

## Project Structure

```
liberty-live/
├── src/
│   ├── server.js          # Express + WebSocket server
│   ├── orchestrator.js    # Show loop and segment scheduling
│   ├── ollama.js          # Ollama API client (streaming)
│   ├── news.js            # RSS feed fetcher
│   └── personality.js     # AI personality and mood detection
├── public/
│   ├── index.html         # Frontend with TalkingHead + controls
│   ├── css/style.css      # Show styling
│   └── avatars/           # Custom avatar .glb files
└── package.json
```

## License

MIT
