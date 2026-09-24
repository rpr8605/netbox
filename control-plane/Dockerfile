# control-plane/Dockerfile
# Control-plane image for the device-identity foundation + React operator console.
# PostgreSQL-only storage (SQLite removed in SQLITE-1/M6).
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
WORKDIR /app
COPY control-plane/package.json control-plane/package-lock.json* ./
RUN npm install --omit=dev
COPY control-plane/src ./src
COPY control-plane/public ./public
COPY --from=console-build /console/dist ./console/dist
COPY control-plane/entrypoint.sh ./entrypoint.sh
COPY schemas/beacon_relay_event.schema.json ./schemas/beacon_relay_event.schema.json
RUN chmod +x ./entrypoint.sh
EXPOSE 9100
ENTRYPOINT ["./entrypoint.sh"]
