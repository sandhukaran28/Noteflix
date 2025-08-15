FROM node:20-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg poppler-utils espeak-ng fonts-dejavu-core wget && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev

COPY . .
EXPOSE 8080
ENV PORT=8080 DATA_ROOT=/data
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://localhost:8080/healthz || exit 1
CMD ["node", "src/server.js"]
