#!/bin/sh
set -eu
echo "Applying Birostweb database migrations..."
npm run db:migrate
if [ "${INITIALIZE_ADMIN:-false}" = "true" ]; then
  echo "Initializing administrator and service catalogue (no demo data)..."
  SEED_DEMO=false npm run db:seed
fi
exec node server/index.js
