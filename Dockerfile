FROM oven/bun:1.4.2 AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
COPY scripts/ scripts/
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src/ src/
COPY config.json.example config.json

ARG VERSION=dev
ARG COMMIT_SHA=
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.source="https://github.com/zumik3-del/synaptomind"
# revision is only set when a source commit is provided (CI/tagged release).
# For local builds COMMIT_SHA is empty — the label is omitted.
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"

ENV NODE_ENV=production
ENV SYNAPTOMIND_DB_PATH=/app/data/synaptomind.db
ENV SYNAPTOMIND_LOG_DB_PATH=/app/data/logs.db
ENV SYNAPTOMIND_EMBEDDER_CACHE_DIR=/app/data/huggingface

# Run as a dedicated non-root user (uid/gid 10001).
# The host-side ./data bind mount must be writable by uid 10001 —
# see README "Docker" section for the migration note.
RUN groupadd --system -g 10001 synaptomind && useradd --system --uid 10001 --gid synaptomind synaptomind \
	&& mkdir -p /app/data && chown -R synaptomind:synaptomind /app/data
USER synaptomind

EXPOSE 3005 3006

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD curl -sf http://127.0.0.1:3005/health || exit 1

CMD ["bun", "run", "src/index.ts"]
