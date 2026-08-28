# device-sim/Dockerfile
# Simulated device for Phase 1 end-to-end testing. Build context: repo root.
FROM node:24-slim
WORKDIR /app
COPY device-sim/package.json device-sim/package-lock.json* ./
RUN npm install --omit=dev
COPY device-sim/src ./src
CMD ["node", "src/index.js"]
