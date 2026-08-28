# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS deps
WORKDIR /app
COPY services/core-api/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:20-alpine AS builder
WORKDIR /app
COPY services/core-api/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY services/core-api ./
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S -G app app
USER app
COPY --from=builder --chown=app:app /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/docs ./docs
ENV NODE_ENV=production
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3001/ready || exit 1
CMD ["node", "dist/server.js"]
