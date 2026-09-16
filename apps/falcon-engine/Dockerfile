# Falcon engine — the deterministic chain (Tracker → Classifier → Base →
# Propagation), always on. Build context MUST be the repo root (pnpm workspace).
# On Railway: Root Directory = / (repo root), Dockerfile Path = apps/falcon-engine/Dockerfile
FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# The whole workspace so the lockfile resolves; .dockerignore trims junk.
COPY . .

# Only this service and its dependency graph (falcon-engine -> @meridian/research).
RUN pnpm install --frozen-lockfile --filter falcon-engine...

# Every engine resolves its own data dir from env. Mount a volume at /data:
# the Tracker's message log and per-ticker state, the Classifier's verdicts and
# the propagation run store all have to survive a restart, or the chain
# re-learns the world (and re-spends the budget) on every deploy.
ENV NODE_ENV=production \
    PORT=8788 \
    FALCON_GRAPH_PATH=/app/apps/desktop/data/graph.json \
    FALCON_TRACKER_DATA_DIR=/data/tracker \
    FALCON_CLASSIFIER_DATA_DIR=/data/classifier \
    FALCON_BASE_DATA_DIR=/data/base \
    FALCON_PROPAGATION_DATA_DIR=/data/propagation \
    FALCON_ANALYST_DATA_DIR=/data/analyst \
    FALCON_RISK_DATA_DIR=/data/risk \
    FALCON_SCREEN_DATA_DIR=/data/screen \
    FALCON_GAUGE_DATA_DIR=/data/gauge \
    FALCON_EVENTS_DATA_DIR=/data/events

EXPOSE 8788
CMD ["pnpm", "--filter", "falcon-engine", "start"]
