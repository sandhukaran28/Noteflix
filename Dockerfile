FROM node:20-bookworm

# --- Basics ---
ENV TMPDIR=/app/tmp
RUN mkdir -p /app/tmp

# --- System deps ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    python3 python3-pip python3-venv \
    ffmpeg poppler-utils \
 && rm -rf /var/lib/apt/lists/*

# --- Python venv + Piper TTS (from OHF-Voice/piper1-gpl) ---
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# Install Piper CLI into the venv (no PEP 668 issues)
RUN pip install --no-cache-dir "piper-tts==1.3.0"

# --- App setup ---
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# --- Piper voices (Hugging Face) ---
# Each voice MUST have .onnx + .onnx.json
RUN mkdir -p /app/models && cd /app/models && \
    curl -LfsS -o en_US-amy-medium.onnx \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx" && \
    curl -LfsS -o en_US-amy-medium.onnx.json \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json" && \
    curl -LfsS -o en_GB-jenny_dioco-medium.onnx \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx" && \
    curl -LfsS -o en_GB-jenny_dioco-medium.onnx.json \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx.json"

# --- Env for your code ---
ENV DATA_ROOT=/data \
    PORT=8080 \
    # piper is on PATH via the venv; keep this in case your code uses it
    PIPER_BIN=piper \
    PIPER_VOICE_A=/app/models/en_US-amy-medium.onnx \
    PIPER_VOICE_B=/app/models/en_GB/jenny_dioco-medium.onnx

EXPOSE 8080
CMD ["node", "src/server.js"]
