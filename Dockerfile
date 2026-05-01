FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Piper TTS binary
RUN wget -qO /tmp/piper.tar.gz \
    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz" \
    && tar -xzf /tmp/piper.tar.gz -C /usr/local \
    && rm /tmp/piper.tar.gz

# Default voice model (en_US-lessac-medium)
RUN mkdir -p /opt/piper/models \
    && wget -qO /opt/piper/models/en_US-lessac-medium.onnx \
       "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx" \
    && wget -qO /opt/piper/models/en_US-lessac-medium.onnx.json \
       "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"

WORKDIR /opt/moltos-media-worker
COPY package*.json ./
RUN npm ci --omit=dev
COPY worker.js .

ENV PIPER_BIN=/usr/local/piper/piper \
    PIPER_MODELS_DIR=/opt/piper/models \
    POLL_INTERVAL_MS=5000

CMD ["node", "worker.js"]
