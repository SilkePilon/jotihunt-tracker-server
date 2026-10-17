FROM oven/bun:1 AS base

ENV TZ=Europe/Amsterdam \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ARG PORT
EXPOSE ${PORT:-3000}

# Git commit of the build (set by CI), reported as the Sentry release
ARG GIT_SHA
ENV SENTRY_RELEASE=${GIT_SHA}

# tini runs as PID 1 and forwards SIGTERM to bun (a PID 1 without a handler ignores it, so pods would wait for SIGKILL)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "--preload", "./src/instrument.ts", "src/index.ts"]
