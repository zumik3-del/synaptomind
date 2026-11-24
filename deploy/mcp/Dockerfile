# MCP stdio variant of the release image.
#
# Third-party runners (Glama, Docker MCP Catalog, MCP clients that only know
# `docker run -i <image>`) start a container with no arguments and expect
# JSON-RPC on stdin. The base image defaults to the HTTP server so
# `docker compose up` keeps working, and this layer only adds the argument.
#
# Everything else is inherited from the base, including the
# io.modelcontextprotocol.server.name label the official MCP Registry verifies.
ARG BASE=ghcr.io/zumik3-del/synaptomind:latest
FROM ${BASE}

CMD ["--stdio"]
