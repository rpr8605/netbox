#!/bin/sh
set -e
# Run the SQLite -> Postgre migration once per Postgres database, then start the
# control plane. The migration is guarded by a marker row in Postgres and by
# renaming the SQLite source to *.migrated after success, so it is safe to run
# on every boot.
node migrate.js
exec node src/index.js
