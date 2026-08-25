FROM node:26.3.0-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26.3.0-bookworm-slim

LABEL org.opencontainers.image.description="MQTT to MeshCore.io Map bridge that listens to a MeshCore MQTT broker and uploads verified MeshCore adverts to the MeshCore.io map."

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

USER node
CMD ["node", "dist/index.js"]
