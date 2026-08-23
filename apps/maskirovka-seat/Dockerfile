ARG MASKIROVKA_PLATFORM=linux/amd64
FROM --platform=${MASKIROVKA_PLATFORM} node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

COPY apps/maskirovka-seat/container-package.json ./package.json
COPY apps/maskirovka-seat/container-pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY apps/maskirovka-seat/container-pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=maskirovka-seat-pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

COPY apps/maskirovka-seat/container-tsconfig.json ./tsconfig.json
COPY apps/maskirovka-seat/src ./src
COPY packages/model-provider/src ./packages/model-provider/src
COPY packages/model-provider-claude/src ./packages/model-provider-claude/src
COPY packages/model-provider-codex/src ./packages/model-provider-codex/src
COPY packages/provider-auth/src ./packages/provider-auth/src
RUN pnpm exec esbuild src/container/main.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --target=node22 \
  --packages=external \
  --alias:@stavka/model-provider=./packages/model-provider/src/index.ts \
  --alias:@stavka/model-provider-claude=./packages/model-provider-claude/src/index.ts \
  --alias:@stavka/model-provider-codex=./packages/model-provider-codex/src/index.ts \
  --alias:@stavka/provider-auth=./packages/provider-auth/src/index.ts \
  --outfile=dist/container.js
RUN pnpm prune --prod

FROM --platform=${MASKIROVKA_PLATFORM} node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

ENV NODE_ENV=production
ENV PORT=4141
ENV HOME=/home/maskirovka
WORKDIR /app

RUN groupadd --system maskirovka \
  && useradd --system --gid maskirovka --create-home maskirovka \
  && mkdir -p /workspace \
  && chown -R maskirovka:maskirovka /workspace /home/maskirovka

COPY --from=build --chown=maskirovka:maskirovka /app/dist ./dist
COPY --from=build --chown=maskirovka:maskirovka /app/node_modules ./node_modules
COPY --from=build --chown=maskirovka:maskirovka /app/package.json ./package.json

USER maskirovka
EXPOSE 4141
CMD ["node", "dist/container.js"]
