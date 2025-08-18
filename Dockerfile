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

# --- Python venv + Piper TTS ---
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

RUN pip install --no-cache-dir "piper-tts==1.3.0"

# --- App setup ---
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# --- Piper voices (Amy = female, Ryan = male) ---
# Each voice MUST have .onnx + .onnx.json
RUN mkdir -p /app/models && cd /app/models && \
    # Female voice (US Amy)
    curl -LfsS -o en_US-amy-medium.onnx \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx" && \
    curl -LfsS -o en_US-amy-medium.onnx.json \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json" && \
    # Male voice (US Ryan)
    curl -LfsS -o en_US-ryan-high.onnx \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx" && \
    curl -LfsS -o en_US-ryan-high.onnx.json \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json"

# --- Env for your code ---
ENV DATA_ROOT=/data \
    PORT=8080 \
    PIPER_BIN=piper \
    PIPER_VOICE_A=/app/models/en_US-amy-medium.onnx \
    PIPER_VOICE_B=/app/models/en_US-ryan-high.onnx

EXPOSE 8080
CMD ["node", "src/server.js"]
