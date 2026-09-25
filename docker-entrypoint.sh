#!/bin/sh
# docker-entrypoint.sh
#
# Render (and most PaaS Docker deploys) has no separate "release phase" the
# way Heroku does — whatever the container's CMD runs on boot has to bring
# the database up to date itself, every single time it starts (first
# deploy, redeploys, restarts). Every step here is safe to re-run:
# `prisma migrate deploy` only applies migrations not yet recorded, and
# bootstrap-db.js's trigger SQL files and seed check are both idempotent
# (see scripts/bootstrap-db.ts).
set -e

echo "→ Applying Prisma migrations..."
npx prisma migrate deploy

echo "→ Applying trigger/data migrations and seeding if needed..."
node dist/scripts/bootstrap-db.js

echo "→ Starting application..."
# tsconfig.json's `include` covers src/, seeds/, scripts/, and tests/, so
# tsc's inferred rootDir is the project root and output mirrors that under
# dist/ — the entry point is dist/src/main.js, not dist/main.js. (CI's own
# workflow already discovered this; package.json's start:prod script now
# matches too.)
exec node dist/src/main
