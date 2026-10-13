FROM rust:slim AS angelic-builder
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone https://github.com/sh1ma/Angelic-Angel.git . && git checkout 169a098e2025cc6e41a50fc8d521c483e21d9b6d
RUN cargo build --release --locked

FROM node:22-trixie-slim
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3t64 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod
COPY --from=angelic-builder /src/target/release/angelic-angel /usr/local/bin/angelic-angel
COPY index.js angelic-start.js ./
COPY src ./src
CMD ["node", "index.js"]
