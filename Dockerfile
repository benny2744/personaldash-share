FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat git openssh-client
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client natively into the flat node_modules
RUN pnpm exec prisma generate

# Next.js telemetry
ENV NEXT_TELEMETRY_DISABLED=1
ENV PRISMA_CLIENT_ENGINE_TYPE="library"
ENV DATABASE_URL="postgresql://user:password@localhost:5432/personaldash"
ENV VAULT_PATH="/vault"
ENV MEETING_S3_ENDPOINT="http://localhost:9000"
ENV MEETING_S3_PUBLIC_BASE="http://localhost:9000"
ENV MEETING_S3_ACCESS_KEY="build"
ENV MEETING_S3_SECRET_KEY="build"
ENV QWEN_FILETRANS_BASE_URL="https://dashscope.aliyuncs.com/api/v1"

RUN pnpm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PRISMA_CLIENT_ENGINE_TYPE="library"

# ffmpeg retained for optional audio conversion helpers (chat voice is Qwen realtime PCM).
RUN apk add --no-cache ffmpeg
# dws (DingTalk Workspace CLI) is a static Go PIE binary declaring the glibc
# interpreter; musl's loader serves it fine since it has no lib dependencies.
RUN mkdir -p /lib64 && ln -sf /lib/ld-musl-x86_64.so.1 /lib64/ld-linux-x86-64.so.2

# Add standard user/group
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts

USER nextjs

EXPOSE 3001

ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

COPY docker-entrypoint.sh /docker-entrypoint.sh
USER root
RUN chmod +x /docker-entrypoint.sh
USER nextjs

CMD ["/docker-entrypoint.sh"]
