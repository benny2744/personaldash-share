#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma migrate deploy --schema=/app/prisma/schema.prisma || echo "Migration failed or already applied"

echo "Starting server..."
exec node server.js
