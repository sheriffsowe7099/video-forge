# Example ComfyUI workflow placeholder

This directory holds your ComfyUI workflow JSON files (exported via
"Export (API format)") that VideoForge patches with prompts, dimensions,
seeds, and reference images. See the README section "Connecting a
generation backend".

VideoForge deliberately ships no real workflow JSON: the correct workflow
depends entirely on which open-source video model and ComfyUI node set you
install. A wrong hard-coded workflow would fail against models it was not
built for, so we ask you to export your own.

Naming convention used by .env.example:

- text-to-video.example.json  — replace with your exported text-to-video workflow
- image-to-video.example.json — replace with your exported image-to-video workflow
