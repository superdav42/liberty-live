#!/bin/bash
# Liberty Live - Headless YouTube RTMP Streaming
#
# Starts a virtual display, opens Chrome with the show in stream mode,
# and pipes video + audio to YouTube Live via ffmpeg.
#
# Prerequisites: Xvfb, google-chrome, ffmpeg (all installed)
# The Liberty Live server must already be running (npm start or AUTO_START=true)
#
# Usage:
#   ./stream.sh              # stream using .env config
#   ./stream.sh --test       # test without sending to YouTube (preview only)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Load .env ────────────────────────────────────────────────────────────────
if [[ -f "$ROOT/.env" ]]; then
  # shellcheck disable=SC2163
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    key="${key// /}"
    value="${value%%#*}"
    value="${value%"${value##*[![:space:]]}"}"
    export "$key=$value"
  done < "$ROOT/.env"
fi

# ── Config ───────────────────────────────────────────────────────────────────
RTMP_URL="${YOUTUBE_RTMP_URL:-rtmp://a.rtmp.youtube.com/live2}"
STREAM_KEY="${YOUTUBE_STREAM_KEY:?YOUTUBE_STREAM_KEY not set in .env}"
SHOW_URL="${SHOW_URL:-http://localhost:3333/?stream}"
DISP="${STREAM_DISPLAY:-:99}"
RES="${STREAM_RESOLUTION:-1280x720}"
FPS="${STREAM_FPS:-30}"
VBITRATE="${STREAM_VIDEO_BITRATE:-3000k}"
ABITRATE="${STREAM_AUDIO_BITRATE:-128k}"
SERVER_PORT="${PORT:-3333}"

# PipeWire Dummy Output monitor — where Chrome's audio goes
AUDIO_SOURCE="auto_null.monitor"
PULSE_SOCK="unix:/run/user/$(id -u)/pulse/native"

# GOP = 2× framerate (YouTube requirement)
GOP=$(( FPS * 2 ))

TEST_MODE=false
if [[ "${1:-}" == "--test" ]]; then
  TEST_MODE=true
  echo "[stream] TEST MODE — no data will be sent to YouTube"
fi

# ── Cleanup ──────────────────────────────────────────────────────────────────
PIDS=()

cleanup() {
  local code=$?
  echo ""
  echo "[stream] Shutting down (exit $code)..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Give processes a moment to exit cleanly
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
  echo "[stream] Done."
  return 0
}
trap cleanup EXIT INT TERM

# ── Preflight ────────────────────────────────────────────────────────────────
echo "[stream] Checking Liberty Live server..."
if ! curl -sf --max-time 3 "http://localhost:${SERVER_PORT}/api/health" > /dev/null; then
  echo "[stream] ERROR: Liberty Live server not responding on port ${SERVER_PORT}"
  echo "[stream] Start it first: AUTO_START=true node src/start.js"
  exit 1
fi
echo "[stream] Server OK"

# Kill any leftover Xvfb on our display
pkill -f "Xvfb $DISP" 2>/dev/null || true
# Kill any leftover Chrome pointing at the show URL
pkill -f "chrome.*stream" 2>/dev/null || true
sleep 1

# ── Virtual Display ──────────────────────────────────────────────────────────
echo "[stream] Starting virtual display $DISP at ${RES}..."
Xvfb "$DISP" -screen 0 "${RES}x24" -ac +extension GLX +render -noreset \
  > /tmp/xvfb-stream.log 2>&1 &
XVFB_PID=$!
PIDS+=("$XVFB_PID")
sleep 1

# Confirm Xvfb is up
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[stream] ERROR: Xvfb failed to start. Check /tmp/xvfb-stream.log"
  exit 1
fi
echo "[stream] Xvfb running (PID $XVFB_PID)"

# ── Chrome ───────────────────────────────────────────────────────────────────
echo "[stream] Starting Chrome on $DISP..."
DISPLAY="$DISP" \
PULSE_SERVER="$PULSE_SOCK" \
XDG_RUNTIME_DIR="/run/user/$(id -u)" \
google-chrome \
  --no-sandbox \
  --test-type \
  --disable-dev-shm-usage \
  --use-gl=angle \
  --use-angle=swiftshader \
  --enable-unsafe-swiftshader \
  --ignore-gpu-blocklist \
  --enable-webgl \
  --enable-webgl2 \
  --enable-features=Vulkan,UseSkiaRenderer \
  --autoplay-policy=no-user-gesture-required \
  --window-size="${RES/x/,}" \
  --window-position=0,0 \
  --start-fullscreen \
  --kiosk \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=TranslateUI,InfoBars \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-extensions \
  --disable-sync \
  --disable-background-networking \
  --disable-breakpad \
  --disable-hang-monitor \
  --disable-component-update \
  --disable-notifications \
  --metrics-recording-only \
  --safebrowsing-disable-auto-update \
  --hide-scrollbars \
  --app="$SHOW_URL" \
  > /tmp/chrome-stream.log 2>&1 &
CHROME_PID=$!
PIDS+=("$CHROME_PID")
echo "[stream] Chrome PID $CHROME_PID"

echo "[stream] Waiting 15s for avatar to load and show to start..."
sleep 15

# Confirm Chrome is still alive
if ! kill -0 "$CHROME_PID" 2>/dev/null; then
  echo "[stream] ERROR: Chrome exited early. Check /tmp/chrome-stream.log"
  tail -20 /tmp/chrome-stream.log
  exit 1
fi
echo "[stream] Chrome alive — beginning stream"

# ── Chrome watchdog ──────────────────────────────────────────────────────────
# Run a background watchdog that checks Chrome is still alive every 30s and
# kills ffmpeg if Chrome dies. systemd will then restart the whole unit, which
# brings Chrome back up. Without this, ffmpeg happily streams a black screen
# to YouTube forever after a Chrome crash.
(
  while true; do
    sleep 30
    if ! kill -0 "$CHROME_PID" 2>/dev/null; then
      echo "[stream:watchdog] Chrome (PID $CHROME_PID) is dead — terminating ffmpeg so unit restarts"
      # Killing ffmpeg drops it from the cgroup. Our EXIT trap will then run
      # cleanup and exit, which flips systemd into restart mode.
      kill "${PIDS[@]}" 2>/dev/null || true
      exit 0
    fi
  done
) &
WATCHDOG_PID=$!
PIDS+=("$WATCHDOG_PID")
echo "[stream] Chrome watchdog running (PID $WATCHDOG_PID)"

# ── ffmpeg → YouTube ─────────────────────────────────────────────────────────
if [[ "$TEST_MODE" == "true" ]]; then
  # Test mode: encode and show stats but don't send anywhere
  FFMPEG_OUTPUT="-f null -"
  echo "[stream] TEST: encoding to /dev/null (press Ctrl+C to stop)"
else
  FFMPEG_OUTPUT="-f flv ${RTMP_URL}/${STREAM_KEY}"
  echo "[stream] Streaming to YouTube Live..."
fi

ffmpeg \
  -f x11grab \
    -framerate "$FPS" \
    -video_size "$RES" \
    -draw_mouse 0 \
    -i "${DISP}+0,0" \
  -f pulse \
    -i "$AUDIO_SOURCE" \
  -c:v libx264 \
    -preset veryfast \
    -tune zerolatency \
    -b:v "$VBITRATE" \
    -maxrate "$VBITRATE" \
    -bufsize "$(echo "$VBITRATE" | tr -d 'k' | awk '{printf "%dk", $1 * 2}')" \
    -pix_fmt yuv420p \
    -g "$GOP" \
    -keyint_min "$FPS" \
  -c:a aac \
    -b:a "$ABITRATE" \
    -ar 44100 \
    -ac 2 \
  $FFMPEG_OUTPUT \
  2>&1 | tee /tmp/ffmpeg-stream.log
