FROM oven/bun:1.3-alpine AS base
WORKDIR /app

# Install deps first (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src ./src
COPY tsconfig.json ./

# Run as non-root
RUN addgroup -S app && adduser -S -G app app
RUN mkdir -p /app/data && chown -R app:app /app
USER app

EXPOSE 8001
ENV HOSTNAME=0.0.0.0
ENV PORT=8001

CMD ["bun", "run", "src/server.ts"]
