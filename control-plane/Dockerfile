# control-plane/Dockerfile
# Control-plane image for the device-identity foundation + React operator console.
# Node 24 slim; better-sqlite3 needs build tools.
# Build context is the repo root so the canonical schema can be copied in.

# Stage 1: build the React console.
FROM node:24-slim AS console-build
WORKDIR /console
COPY control-plane/console/package.json control-plane/console/package-lock.json* ./
RUN npm install
COPY control-plane/console/ ./
RUN npm run build

# Stage 2: main control-plane image.
FROM node:24-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY control-plane/package.json control-plane/package-lock.json* ./
RUN npm install --omit=dev
COPY control-plane/src ./src
COPY control-plane/public ./public
COPY --from=console-build /console/dist ./console/dist
COPY control-plane/entrypoint.sh ./entrypoint.sh
COPY control-plane/migrate.js ./migrate.js
COPY schemas/beacon_relay_event.schema.json ./schemas/beacon_relay_event.schema.json
RUN chmod +x ./entrypoint.sh
EXPOSE 9100
ENTRYPOINT ["./entrypoint.sh"]
