#!/bin/sh
set -e
# Start the control plane. Schema creation/updates run automatically inside
# src/db.js on boot (PostgreSQL-only, guarded by an advisory transaction lock).
exec node src/index.js
