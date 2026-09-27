FROM oven/bun:1 AS base

ENV TZ=Europe/Amsterdam \
    NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ARG PORT
EXPOSE ${PORT:-3000}

CMD ["bun", "run", "src/index.ts"]
