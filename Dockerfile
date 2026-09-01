FROM oven/bun:1 AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
COPY scripts/ scripts/
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src/ src/
COPY config.json.example config.json

ENV NODE_ENV=production
ENV SYNAPTOMIND_DB_PATH=/app/data/synaptomind.db
ENV SYNAPTOMIND_LOG_DB_PATH=/app/data/logs.db
ENV SYNAPTOMIND_EMBEDDER_CACHE_DIR=/app/data/huggingface

RUN mkdir -p /app/data

EXPOSE 3005 3006

CMD ["bun", "run", "src/index.ts"]
