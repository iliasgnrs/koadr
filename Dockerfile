# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# CI-friendly env
ENV HUSKY=0
ENV CI=true

# Use pnpm
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Ensure git is available for build and runtime scripts
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# Accept (optional) build-time public URL for Remix/Vite (Coolify can pass it)
ARG VITE_PUBLIC_APP_URL
ENV VITE_PUBLIC_APP_URL=${VITE_PUBLIC_APP_URL}

# Copy source and install (dev deps are needed to build).
#
# `pnpm fetch` + `pnpm install` as separate layers used to leave a ~1.4 GB
# pnpm-store layer in the image that nothing at runtime reads. Installing in
# one layer and pruning the store straight after keeps that out, at the cost
# of a weaker dependency cache — the image is ~1.4 GB smaller.
COPY . .
RUN pnpm install --frozen-lockfile && pnpm store prune

# Build for the Node/VPS target: client bundle + React Router server build + the
# compiled Node entry (build/server-node). Not `pnpm build` — that emits a
# workerd bundle consumed by `wrangler deploy`.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build:node

# ---- production dependencies stage ----
FROM build AS prod-deps

# Keep only production deps for runtime
RUN pnpm prune --prod --ignore-scripts


# ---- production stage ----
FROM prod-deps AS koadr-production
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
# Caddy reaches this container over the shared `proxy` network by name.
ENV CLIENT_DIR=/app/build/client
ENV SERVER_BUILD=/app/build/server/index.js

# Non-sensitive build arguments
ARG VITE_LOG_LEVEL=debug
ARG DEFAULT_NUM_CTX

# Set non-sensitive environment variables
ENV WRANGLER_SEND_METRICS=false \
    VITE_LOG_LEVEL=${VITE_LOG_LEVEL} \
    DEFAULT_NUM_CTX=${DEFAULT_NUM_CTX} \
    RUNNING_IN_DOCKER=true

# Note: API keys should be provided at runtime via docker run -e or docker-compose
# Example: docker run -e OPENAI_API_KEY=your_key_here ...

# Install curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Copy built files with the right owner up front. `chown -R` afterwards would
# copy every layer again — it turned a ~1 GB layer into 2 GB on the VPS.
COPY --from=prod-deps --chown=koadr:koadr /app/build /app/build
COPY --from=prod-deps --chown=koadr:koadr /app/node_modules /app/node_modules
COPY --from=prod-deps --chown=koadr:koadr /app/package.json /app/package.json

# Run as an unprivileged user; the app writes nothing into /app at runtime.
RUN useradd --system --uid 1001 --create-home koadr
USER koadr

EXPOSE 3000

# Healthcheck for deployment platforms
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD curl -fsS http://localhost:3000/ || exit 1

CMD ["node", "build/server-node/server/app.js"]


# ---- development stage ----
FROM build AS development

# Non-sensitive development arguments
ARG VITE_LOG_LEVEL=debug
ARG DEFAULT_NUM_CTX

# Set non-sensitive environment variables for development
ENV VITE_LOG_LEVEL=${VITE_LOG_LEVEL} \
    DEFAULT_NUM_CTX=${DEFAULT_NUM_CTX} \
    RUNNING_IN_DOCKER=true

# Note: API keys should be provided at runtime via docker run -e or docker-compose
# Example: docker run -e OPENAI_API_KEY=your_key_here ...

RUN mkdir -p /app/run
CMD ["pnpm", "run", "dev", "--host"]
