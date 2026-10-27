# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app

ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
RUN npm install --workspaces --include-workspace-root

COPY packages/shared packages/shared
COPY packages/web packages/web
RUN npm run build --workspace @dj-sync/web

FROM nginx:1.27-alpine AS runtime
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
