FROM rust:slim AS angelic-builder
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone https://github.com/sh1ma/Angelic-Angel.git . && git checkout 169a098e2025cc6e41a50fc8d521c483e21d9b6d
RUN cargo build --release --locked

FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3t64 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=angelic-builder /src/target/release/angelic-angel /usr/local/bin/angelic-angel
COPY . .
CMD ["node", "index.js"]
