ARG MASKIROVKA_PLATFORM=linux/amd64
FROM --platform=${MASKIROVKA_PLATFORM} node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

# The Wrangler image build context is the repository root. Keep the install
# independent of workspace links: first-party source is bundled below.
COPY services/inference/container-package.json ./package.json
COPY services/inference/container-pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY services/inference/container-pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=maskirovka-gateway-pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

COPY packages/access-auth/src ./packages/access-auth/src
COPY packages/protocol/src ./packages/protocol/src
COPY tools/maskirovka/src ./tools/maskirovka/src
COPY services/inference/container-smoke.mjs ./container-smoke.mjs
RUN pnpm exec esbuild tools/maskirovka/src/container/main.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --target=node22 \
  --packages=external \
  --alias:@stavka/access-auth=./packages/access-auth/src/index.ts \
  --alias:@stavka/protocol=./packages/protocol/src/index.ts \
  --metafile=container-meta.json \
  --outfile=dist/container.js
ENV CI=true
RUN pnpm prune --prod
RUN --network=none node ./container-smoke.mjs ./dist/container.js ./container-meta.json

FROM --platform=${MASKIROVKA_PLATFORM} node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

ENV NODE_ENV=production
ENV PORT=4141
ENV MASKIROVKA_HOST=0.0.0.0
ENV MASKIROVKA_PORT=4141
ENV MASKIROVKA_STATE_DIR=/tmp/maskirovka-state
ENV MASKIROVKA_CACHE_DIR=/tmp/maskirovka-cache
ENV HOME=/home/maskirovka
ENV CODEX_HOME=/home/maskirovka/.codex
WORKDIR /app

# Install both official provider CLIs. Credentials are supplied only by the
# Container DO at runtime; this layer contains no provider secrets.
RUN npm install --global @anthropic-ai/claude-code@2.1.226 @openai/codex@0.146.0 \
  && groupadd --system maskirovka \
  && useradd --system --gid maskirovka --create-home maskirovka \
  && mkdir -p /tmp/maskirovka-state /tmp/maskirovka-cache /workspace /home/maskirovka/.codex \
  && chown -R maskirovka:maskirovka /tmp/maskirovka-state /tmp/maskirovka-cache /workspace /home/maskirovka

COPY --from=build --chown=maskirovka:maskirovka /app/dist ./dist
COPY --from=build --chown=maskirovka:maskirovka /app/node_modules ./node_modules
COPY --from=build --chown=maskirovka:maskirovka /app/package.json ./package.json

USER maskirovka
EXPOSE 4141
CMD ["node", "dist/container.js"]
