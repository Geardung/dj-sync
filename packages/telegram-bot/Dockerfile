# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/telegram-bot/package.json packages/telegram-bot/
RUN npm install --workspaces --include-workspace-root

COPY packages/shared packages/shared
COPY packages/telegram-bot packages/telegram-bot
RUN npm run build --workspace @dj-sync/telegram-bot

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY packages/telegram-bot/package.json packages/telegram-bot/
COPY --from=build /app/packages/telegram-bot/dist packages/telegram-bot/dist
COPY --from=build /app/node_modules node_modules

WORKDIR /app/packages/telegram-bot
CMD ["node", "dist/index.js"]
