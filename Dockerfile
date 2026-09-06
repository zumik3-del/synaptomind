FROM oven/bun:1 AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
COPY scripts/ scripts/
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src/ src/
COPY config.json.example config.json

ARG VERSION=dev
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.source="https://github.com/zumik3-del/synaptomind"
LABEL org.opencontainers.image.revision="${VERSION}"

ENV NODE_ENV=production
ENV SYNAPTOMIND_DB_PATH=/app/data/synaptomind.db
ENV SYNAPTOMIND_LOG_DB_PATH=/app/data/logs.db
ENV SYNAPTOMIND_EMBEDDER_CACHE_DIR=/app/data/huggingface

RUN mkdir -p /app/data && chown -R synaptomind:synaptomind /app/data

# Run as a dedicated non-root user (uid/gid 10001).
# The host-side ./data bind mount must be writable by uid 10001 —
# see README "Docker" section for the migration note.
RUN groupadd --system -g 10001 synaptomind && useradd --system --uid 10001 --gid synaptomind synaptomind
USER synaptomind

EXPOSE 3005 3006

CMD ["bun", "run", "src/index.ts"]
