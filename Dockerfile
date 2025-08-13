FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
EXPOSE 8080
ENV PORT=8080 DATA_ROOT=/data
CMD ["node", "src/server.js"]
