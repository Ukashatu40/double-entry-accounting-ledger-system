# Dockerfile
FROM node:20-alpine AS base
WORKDIR /app

# ── deps stage ──────────────────────────────
FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production

# ── build stage ─────────────────────────────
FROM base AS builder
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

# ── development stage ────────────────────────
FROM base AS development
ENV NODE_ENV=development

COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate

EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# ── production stage ─────────────────────────
# Kept as the LAST stage in this file deliberately: `docker build .` with
# no --target builds whichever stage is last, and Render's Blueprint here
# doesn't pass a target — it was silently building `development` (and its
# `nest start --watch`, a memory-hungry TS watch compiler) instead of this
# stage, which is what actually OOM'd on Render's small instance.
FROM base AS production
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
# Prisma 7's config file — schema.prisma's own `url` line is deliberately
# commented out in favor of this (see prisma.config.ts); without it,
# `prisma migrate deploy` fails with "datasource.url property is required."
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# The trigger/data-migration SQL files bootstrap-db.js applies at boot —
# see docker-entrypoint.sh. Raw .sql, not part of the TS build output.
COPY --from=builder /app/database ./database
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]