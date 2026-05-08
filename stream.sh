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

# ── GPU group bootstrap ──────────────────────────────────────────────────────
# systemd user services inherit groups from user@<uid>.service, which usually
# was started long before we added "video"/"render" to the user. If we don't
# yet have those groups in this process, re-exec under sg(1) so the children
# (Chrome, ffmpeg) inherit them and can open /dev/dri/* for GPU rendering and
# NVENC. Skip if the user manager has already been restarted with new groups.
if [[ "${LIBERTY_GPU_BOOTSTRAPPED:-0}" != "1" ]]; then
  if ! id -G | tr ' ' '\n' | grep -q '^110$'; then
    if command -v sg >/dev/null 2>&1; then
      echo "[stream] Re-executing under 'sg render' so Chrome/ffmpeg can reach /dev/dri/*"
      export LIBERTY_GPU_BOOTSTRAPPED=1
      # sg only adds one group at a time; we need both video (card*) and
      # render (renderD*). Nest them.
      exec sg render -c "sg video -c '$0 $*'"
    else
      echo "[stream] WARNING: not in render group and 'sg' not available — GPU path will fail back to swiftshader"
    fi
  fi
fi

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
# GPU-accelerated WebGL via NVIDIA EGL.
#
# The host has NVIDIA P102 cards with the proprietary driver (libEGL_nvidia).
# Chrome's GPU process opens /dev/dri/renderD128 (renderD128 is on NVIDIA via
# nvidia-drm) to get a real OpenGL context, then composites into the X11 window
# on Xvfb. This needs the user to be in the "render" group (and "video" for
# /dev/dri/card*). Done at install time:
#   sudo usermod -aG video,render dave
#
# If the GPU path fails for any reason, Chrome falls back to swiftshader on its
# own (it logs "GpuProcessHost: GPU process exited" and respawns).
#
# Flag rationale:
#   --use-gl=angle --use-angle=gl: ANGLE in passthrough-to-native-GL mode
#       (instead of swiftshader). On NVIDIA this picks up libGL via the
#       NVIDIA driver.
#   --enable-features=VaapiVideoDecoder: NVIDIA NVDEC for any video the page
#       might play (not strictly needed for our avatar).
#   --ignore-gpu-blocklist: P102 mining cards aren't on Chrome's allowlist;
#       the blocklist would otherwise force swiftshader fallback.
#   --enable-zero-copy / --enable-gpu-rasterization: make the GPU path the
#       fast path for compositing.
echo "[stream] Starting Chrome on $DISP (GPU: NVIDIA EGL)..."
DISPLAY="$DISP" \
PULSE_SERVER="$PULSE_SOCK" \
XDG_RUNTIME_DIR="/run/user/$(id -u)" \
__GLX_VENDOR_LIBRARY_NAME=nvidia \
__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json \
google-chrome \
  --no-sandbox \
  --test-type \
  --disable-dev-shm-usage \
  --use-gl=angle \
  --use-angle=gl \
  --ignore-gpu-blocklist \
  --enable-gpu-rasterization \
  --enable-zero-copy \
  --enable-webgl \
  --enable-webgl2 \
  --enable-features=VaapiVideoDecoder,UseSkiaRenderer,Vulkan \
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

# ── Video encoder selection ──────────────────────────────────────────────────
# Prefer h264_nvenc (NVIDIA hardware encoder), but actually probe — some cards
# (e.g. P102-100 mining boards) list NVENC in ffmpeg's encoder table because
# the driver loads it, but the silicon has NVENC fused off. The probe runs a
# 1-frame encode against /dev/null and checks the exit code.
#
# Set FORCE_LIBX264=1 in .env to skip the probe and always use libx264.
USE_NVENC=false
if [[ "${FORCE_LIBX264:-0}" != "1" ]]; then
  if ffmpeg -hide_banner -loglevel error \
        -f lavfi -i "color=c=black:s=128x128:d=0.1" \
        -c:v h264_nvenc -f null - 2>/dev/null; then
    USE_NVENC=true
  fi
fi

if [[ "$USE_NVENC" == "true" ]]; then
  # NVENC: GPU encode, near-zero CPU cost, consistent frame timing.
  VIDEO_CODEC_ARGS=(
    -c:v h264_nvenc
    -preset p4
    -tune ll
    -profile:v high
    -rc cbr
    -b:v "$VBITRATE"
    -maxrate "$VBITRATE"
    -bufsize "$VBITRATE"
    -pix_fmt yuv420p
    -g "$GOP"
    -keyint_min "$FPS"
    -bf 0
  )
  echo "[stream] Using NVENC hardware H.264 encoder"
else
  BUFSIZE_K="$(echo "$VBITRATE" | tr -d 'k' | awk '{printf "%dk", $1 * 2}')"
  VIDEO_CODEC_ARGS=(
    -c:v libx264
    -preset veryfast
    -tune zerolatency
    -b:v "$VBITRATE"
    -maxrate "$VBITRATE"
    -bufsize "$BUFSIZE_K"
    -pix_fmt yuv420p
    -g "$GOP"
    -keyint_min "$FPS"
  )
  echo "[stream] Using libx264 CPU encoder (NVENC unavailable on this GPU)"
fi

# shellcheck disable=SC2086  # FFMPEG_OUTPUT intentionally word-split
ffmpeg \
  -f x11grab \
    -framerate "$FPS" \
    -video_size "$RES" \
    -draw_mouse 0 \
    -i "${DISP}+0,0" \
  -f pulse \
    -i "$AUDIO_SOURCE" \
  "${VIDEO_CODEC_ARGS[@]}" \
  -c:a aac \
    -b:a "$ABITRATE" \
    -ar 44100 \
    -ac 2 \
  $FFMPEG_OUTPUT \
  2>&1 | tee /tmp/ffmpeg-stream.log
