FROM node:24-bookworm-slim AS node-deps
WORKDIR /app
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS frontend-builder
WORKDIR /frontend
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate
COPY frontend ./
RUN pnpm install --frozen-lockfile --filter skyroc-admin... \
    && pnpm --filter skyroc-admin build \
    && ! grep -R "%VITE_" apps/admin/dist/index.html

FROM python:3.12-slim-bookworm AS runtime
COPY --from=node:24-bookworm-slim /usr/local/ /usr/local/
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PATH=/opt/venv/bin:$PATH \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1
WORKDIR /app
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app \
    && python -m venv /opt/venv
COPY vendor/hidemyemail-generator ./vendor/hidemyemail-generator
RUN /opt/venv/bin/pip install --no-cache-dir ./vendor/hidemyemail-generator
COPY --from=node-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY python ./python
COPY scripts ./scripts
COPY --from=frontend-builder /frontend/apps/admin/dist ./frontend/apps/admin/dist
RUN mkdir -p /app/data && chown -R app:app /app /opt/venv
USER app
EXPOSE 4173
CMD ["node", "src/server.mjs"]
