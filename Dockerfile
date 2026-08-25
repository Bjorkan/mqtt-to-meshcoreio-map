FROM oven/bun:1-slim

LABEL org.opencontainers.image.description="MQTT to MeshCore.io Map bridge that listens to a MeshCore MQTT broker and uploads verified MeshCore adverts to the MeshCore.io map."

ENV NODE_ENV=production
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

USER bun
CMD ["bun", "src/index.ts"]
