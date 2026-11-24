# MCP stdio variant of the release image.
#
# Third-party runners (Glama, Docker MCP Catalog, clients that only know
# `docker run -i <image>`) start a container with no arguments and expect
# JSON-RPC on stdin. The base image runs the HTTP server so `docker compose up`
# keeps working; this layer only changes the command.
#
# BASE is pinned to a release so a plain `docker build deploy/mcp` is
# reproducible; CI overrides it with the image it just built. scripts/release.sh
# moves the pin together with the version.
ARG BASE=ghcr.io/zumik3-del/synaptomind:0.26.3
FROM ${BASE}

# Inherited from the base, repeated so a standalone Dockerfile scan sees it.
USER synaptomind

# The inherited check probes the HTTP listener on :3005, which never runs here.
HEALTHCHECK NONE

CMD ["--stdio"]
