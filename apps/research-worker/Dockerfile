# Compute API for mobile + desktop Step-1 / signals / brokerage.
# Build context MUST be the repo root (pnpm workspace). On Railway:
#   Root Directory = / (repo root), Dockerfile Path = apps/research-worker/Dockerfile
FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile --filter research-worker...

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV HOST=0.0.0.0

EXPOSE 8787

CMD ["pnpm", "--filter", "research-worker", "start"]
