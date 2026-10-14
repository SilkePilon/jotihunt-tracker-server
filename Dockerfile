FROM oven/bun:1 AS base

ENV TZ=Europe/Amsterdam \
    NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Git commit of the build (set by CI), reported as the Sentry release
ARG GIT_SHA
ENV SENTRY_RELEASE=${GIT_SHA}

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ARG PORT
EXPOSE ${PORT:-3000}

# tini runs as PID 1 and reaps the orphaned chromium/crashpad processes left behind by puppeteer
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "--preload", "./src/instrument.ts", "src/index.ts"]
