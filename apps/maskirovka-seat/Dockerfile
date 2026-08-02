ARG MASKIROVKA_PLATFORM=linux/amd64
FROM --platform=${MASKIROVKA_PLATFORM} node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

COPY container-package.json ./package.json
COPY container-pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN --mount=type=cache,id=maskirovka-seat-pnpm,target=/pnpm/store \
  pnpm install --no-frozen-lockfile

COPY container-tsconfig.json ./tsconfig.json
COPY src ./src
RUN pnpm exec esbuild src/container/main.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --target=node22 \
  --packages=external \
  --outfile=dist/container.js
RUN pnpm prune --prod

FROM --platform=${MASKIROVKA_PLATFORM} node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=4141
ENV HOME=/home/maskirovka
ENV CODEX_HOME=/home/maskirovka/.codex
WORKDIR /app

RUN groupadd --system maskirovka \
  && useradd --system --gid maskirovka --create-home maskirovka \
  && mkdir -p /workspace /home/maskirovka/.codex \
  && chown -R maskirovka:maskirovka /workspace /home/maskirovka

COPY --from=build --chown=maskirovka:maskirovka /app/dist ./dist
COPY --from=build --chown=maskirovka:maskirovka /app/node_modules ./node_modules
COPY --from=build --chown=maskirovka:maskirovka /app/package.json ./package.json

USER maskirovka
EXPOSE 4141
CMD ["node", "dist/container.js"]
