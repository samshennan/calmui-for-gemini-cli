#!/usr/bin/env bash
# Launch Gemini CLI against Vertex AI (Veles project), ignoring any
# GEMINI_API_KEY / GOOGLE_API_KEY inherited from the user environment.
# Use this instead of bare `gemini` on machines where the public Gemini
# API keys are also configured (e.g. personal projects on the same box).
set -euo pipefail
exec env -u GEMINI_API_KEY -u GOOGLE_API_KEY GOOGLE_GENAI_USE_VERTEXAI=true gemini "$@"
