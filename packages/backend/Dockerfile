# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app

# yt-dlp + ffmpeg for track resolve
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg curl ca-certificates \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN npm install --workspaces --include-workspace-root

COPY packages/shared packages/shared
COPY packages/backend packages/backend
RUN npm run build --workspace @dj-sync/backend

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV AUDIO_DIR=/data/audio
ENV PHOTOS_DIR=/data/photos
ENV IMG_DIR=/app/assets

COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/shared/src packages/shared/src
COPY --from=build /app/packages/backend/dist packages/backend/dist
COPY --from=build /app/node_modules node_modules

# ambient lo-fi playlist (single file, looped when the guest queue is empty)
COPY assets/lo-fi-halloween.mp3 /data/audio/lo-fi-halloween.mp3
COPY assets/lofi-cover.jpg /app/assets/lofi-cover.jpg

RUN mkdir -p /data/audio /data/photos
EXPOSE 3000
WORKDIR /app/packages/backend
CMD ["node", "dist/index.js"]
