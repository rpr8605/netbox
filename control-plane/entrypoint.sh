#!/bin/sh
set -e
# Run the SQLite -> Postgre migration if both source and target are configured,
# then start the control plane. The migration is idempotent, so it is safe to
# run on every boot.
node migrate.js
exec node src/index.js
