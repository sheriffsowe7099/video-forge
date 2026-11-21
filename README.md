# video-forge

Self-hostable AI video generation workspace.

VideoForge is a self-hostable web application for creating videos from a text
prompt (text-to-video) or an uploaded image plus a prompt (image-to-video),
up to five minutes long. It works by generating a sequence of shorter scenes
with open-source, self-hosted generation backends (such as ComfyUI or a
Diffusers-based service) and assembling them locally with FFmpeg.

- No paid AI APIs or usage-based third-party generation services are required.
- You bring your own hardware: a GPU (or other inference-capable machine),
  storage, and electricity for the generation backend.
- Nothing is labeled "free and unlimited"; long videos take substantial
  compute time and resources.
- If no generation backend is configured, the app shows an honest
  "backend not configured" state instead of fabricating videos or progress.

This README is a temporary placeholder. The complete application, its
documentation, and its test suite are being added via pull request.
