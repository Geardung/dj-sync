# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/vk-bot/package.json packages/vk-bot/
RUN npm install --workspaces --include-workspace-root

COPY packages/shared packages/shared
COPY packages/vk-bot packages/vk-bot
RUN npm run build --workspace @dj-sync/vk-bot

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY packages/vk-bot/package.json packages/vk-bot/
COPY --from=build /app/packages/vk-bot/dist packages/vk-bot/dist
COPY --from=build /app/node_modules node_modules

WORKDIR /app/packages/vk-bot
CMD ["node", "dist/index.js"]
