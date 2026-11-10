FROM rust:1.99-slim-bookworm AS build
WORKDIR /build
COPY rust ./rust
RUN cargo build --manifest-path rust/Cargo.toml --release --locked

FROM debian:bookworm-slim
LABEL org.opencontainers.image.description="MQTT to MeshCore.io Map bridge that listens to a MeshCore MQTT broker and uploads verified MeshCore adverts to the MeshCore.io map."
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /build/rust/target/release/mqtt-to-meshcoreio-map /app/mqtt-to-meshcoreio-map
USER 65532:65532
CMD ["/app/mqtt-to-meshcoreio-map"]
