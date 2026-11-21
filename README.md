# VideoForge — Self-hosted AI Video Studio

VideoForge is a self-hostable web application for creating videos from a text
prompt (text-to-video) or an uploaded image plus a prompt (image-to-video),
with a total duration of up to five minutes. It plans an editable storyboard of
shorter scenes, generates each scene with your own self-hosted, open-source
generation backend (e.g. ComfyUI with an open video model), and assembles the
clips locally with FFmpeg.

> Important — how long videos are made: no AI model reliably generates a
> continuous five-minute scene in one operation. VideoForge divides the requested
> duration into scenes (5 to 300 seconds), generates each scene as a short clip
> using durations your backend actually supports, and stitches them. Long
> videos therefore require substantial compute time and disk space.

## What this app does and does not do

Does:
- Create projects (text-to-video or image-to-video) with a prompt, negative
  prompt, aspect ratio, style direction, and scene plan.
- Build an editable storyboard: edit scene prompts, reorder, add/remove scenes,
  adjust durations, regenerate individual scenes.
- Submit generation jobs to a self-hosted backend with per-scene status
  (pending, queued, generating, succeeded, failed, canceled), cancellation, and
  per-scene retry that preserves successful scenes.
- Assemble clips with FFmpeg (scale/pad to your aspect ratio, 24 fps, H.264 +
  AAC MP4), optional burned-in captions, optional uploaded music with volume,
  fade in/out, and a limiter that prevents clipping.
- Show the real output: preview player, download, and honest metadata
  (format, codec, resolution, duration, size).
- A "Backend status" page showing whether the generation backend is configured
  and reachable, and whether FFmpeg is installed.

Does not:
- Call any paid AI API. There is no paid key, no subscription, no usage-based
  third-party service in the core workflow. The app never sends your prompts,
  images, or media anywhere external.
- Download model weights automatically. You choose, download, and license-check
  the open-source model your backend runs.
- Fabricate videos or progress. With no backend configured the UI shows
  "backend not configured" and generation is refused. If a backend reports no
  progress events, the UI shows an indeterminate indicator, not a fake percent.
- Provide multi-user security. The default deployment is for a single trusted
  user (see Security).

## Prerequisites

- Node.js 20.10 or newer, npm 10+ (workspaces)
- FFmpeg 5+ on PATH (Windows: a static build or winget; macOS:
  brew install ffmpeg; Debian/Ubuntu: sudo apt install ffmpeg)
- A generation backend you host, e.g. ComfyUI with an open-source video model
  (needs your GPU/VRAM)
- Disk space: clips plus the final video live under data/. A five-minute 768p
  video can be hundreds of MB.

You provide the GPU, electricity, storage, and bandwidth. Hosting providers
charge for compute. VideoForge is not "free unlimited generation" — resource
use depends on your hardware and settings.

## Quick start

    git clone https://github.com/sheriffsowe7099/video-forge.git
    cd video-forge
    npm install

    # Terminal 1 — API server (http://127.0.0.1:3001)
    npm run dev:server

    # Terminal 2 — web app (http://localhost:5173, /api proxied to the server)
    npm run dev:web

Open http://localhost:5173. With no backend configured you can create and edit
storyboards; the Start generation button will return an honest error until a
backend is connected.

Production build:

    npm run build
    npm run start   # serves the API; serve packages/web/dist behind a proxy

## Configuration (environment variables)

Copy .env.example to .env and edit. Never commit real secrets.

- VF_PORT (default 3001) — API port
- VF_HOST (default 127.0.0.1) — bind address. Keep localhost unless you proxy
  with authentication
- VF_DATA_DIR (default ./data) — all uploads, clips, outputs, and the job store
- VF_PROVIDER (unset = none) — comfyui or none. No paid providers exist.
- VF_MAX_UPLOAD_BYTES (default 20971520) — upload size cap (20 MiB)
- VF_RETENTION_DAYS (default 30) — completed project data older than this is
  deleted daily
- VF_MAX_CONCURRENT_JOBS (default 2) — concurrent render job guard

### ComfyUI backend variables (needed when VF_PROVIDER=comfyui)

- VF_COMFY_URL — base URL, e.g. http://127.0.0.1:8188
- VF_COMFY_TEXT_WORKFLOW — path to your exported text-to-video workflow JSON
- VF_COMFY_IMAGE_WORKFLOW — path to an image-to-video workflow JSON (enables I2V)
- VF_COMFY_PROMPT_NODE — node id receiving the positive prompt (default 6)
- VF_COMFY_NEGATIVE_NODE — node id receiving the negative prompt (optional)
- VF_COMFY_DIMENSION_NODE — node id receiving width/height (optional)
- VF_COMFY_SEED_NODE — node id receiving the seed (optional; enables
  reproducibility)
- VF_COMFY_IMAGE_NODE — node id receiving the reference image (I2V)
- VF_COMFY_OUTPUT_NODE — node id whose output is the video
  (default VHS_VideoCombine)

## Connecting a generation backend

The app speaks to a backend you host. ComfyUI is the supported adapter:
model-specific logic lives in your workflow JSON, not in this app.

1. Install ComfyUI and an open-source video model of your choice. VideoForge
   does not pick or download models — check the model's own license and usage
   restrictions yourself.
2. In ComfyUI, build a workflow that generates one short video clip, then use
   Export (API format) to save the JSON.
3. Note the node ids for: positive prompt, negative prompt (if present),
   width/height (if present), seed (if present), input image (for I2V), and the
   video output node.
4. Point VF_COMFY_TEXT_WORKFLOW (and optionally VF_COMFY_IMAGE_WORKFLOW) at the
   JSON files, set the node id variables, set VF_PROVIDER=comfyui, and restart
   the server.
5. Health check: open the web app's Backend status page or GET /api/health. It
   reports available: true only when the backend is reachable, plus its
   configured capabilities. It does not guess.

Only settings the configured backend supports are offered in the UI (clip
durations, resolutions, I2V, seed). If your backend cannot meet a setting, the
server rejects it with an explanation instead of silently changing it.

To add another open-source backend: implement the GenerationProvider interface
in packages/server/src/providers/ and register it in the factory. Nothing else
needs to change.

## Data, storage, privacy, and cleanup

- Everything is stored locally under VF_DATA_DIR. No cloud storage, no
  telemetry, no external requests other than to your own backend.
- Uploads and generated files are private by default and served only through
  project-scoped API routes (/api/projects/:id/...).
- Completed projects older than VF_RETENTION_DAYS are deleted by a daily
  cleanup. Delete a project to remove all its files immediately.
- Logs: the server logs only request error messages, not prompts, file
  contents, or secrets.

## Security

- Single-trusted-user default. There is no authentication system; the server
  binds to 127.0.0.1 and the dev web app proxies to it. If you expose it, put
  it behind a reverse proxy with authentication you control. There is no
  multi-user isolation; do not present a public deployment as multi-user safe.
- All client input is validated on the server (prompts, durations, sizes,
  uploads, seeds, volumes).
- Uploads: MIME allowlist (PNG/JPEG/WebP), size cap, server-side validation.
- Filenames are sanitized; storage keys are validated against path traversal.
- FFmpeg is invoked with argument arrays via spawn — no shell, no string
  concatenation. User text (captions) is passed via files, not arguments.
- Secrets only ever live in server-side environment variables; they are never
  exposed to the client bundle.

## Testing, checks, CI

    npm test           # unit tests (node test runner + vitest for web)
    npm run typecheck  # tsc --noEmit across workspaces
    npm run build      # web production build

CI (.github/workflows/ci.yml) runs install, typecheck, tests, and build on every
push and PR.

## Troubleshooting

- "Backend not configured" — set VF_PROVIDER=comfyui and the workflow/node
  variables; restart the server.
- Backend unreachable — check the backend is running and VF_COMFY_URL is
  right; use the Backend status page to re-check.
- Out-of-memory errors from the backend — lower output height/resolution, use
  fewer scenes, or a smaller/quantized model; generation uses your GPU's VRAM.
- Scene failed, others fine — use "Retry this scene"; successful scenes are kept.
- FFmpeg errors or "FFmpeg is not installed" — install FFmpeg on PATH.
- Generation times out (20 min per scene) — backend overloaded or model too
  slow for the clip length; reduce clip duration or resolution.
- Upload rejected — check the image is PNG/JPEG/WebP and under 20 MiB.

## Licenses

- VideoForge app code: MIT (this repository).
- FFmpeg: LGPL/GPL — depends on your build; check your distribution.
- ComfyUI: GPL-3.0. Running it as a separate process keeps the licenses distinct.
- Models are not interchangeable in licensing. Every open-source model has its
  own license and use restrictions (some are non-commercial or require
  attribution). You choose and run the model; verify its license yourself.
  VideoForge ships no model weights and claims nothing about model licenses.

## Repository layout

- packages/shared — domain types, validation, duration planner (pure, tested)
- packages/server — HTTP API, job store, render pipeline, providers, FFmpeg
  worker
- packages/web — React + TypeScript UI (dashboard, storyboard, backend status)
