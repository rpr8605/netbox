# control-plane/Dockerfile
# Phase 1/2 control plane image. Node 24 slim; better-sqlite3 needs build tools.
# Build context is the repo root so the canonical schema can be copied in.
FROM node:24-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY control-plane/package.json control-plane/package-lock.json* ./
RUN npm install --omit=dev
COPY control-plane/src ./src
COPY control-plane/public ./public
COPY schemas/netbox_event.schema.json ./schemas/netbox_event.schema.json
EXPOSE 9100
CMD ["node", "src/index.js"]
