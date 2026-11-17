# One execution node (apps/server). No npm install: the engine has no runtime dependencies and Node runs the TypeScript directly.
# Build from the repo root:  docker build -f deploy/server/Dockerfile -t memedesk-node .
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/server ./apps/server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3500
USER node
EXPOSE 3500
# readiness: Redis reachable and not draining
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3500/readyz >/dev/null || exit 1
# SIGTERM -> drain: stop claiming, stop Traders, release leases so other nodes take over at once
STOPSIGNAL SIGTERM
CMD ["node", "--experimental-transform-types", "--no-warnings", "apps/server/main.ts"]
