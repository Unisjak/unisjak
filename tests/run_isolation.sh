#!/bin/bash
# Bruger: tests/run_isolation.sh  (kræver lokal Postgres på port 5544, se fresh.sh)
set -e
bash /var/tmp/fresh.sh iso_run >/dev/null
psql -h /tmp -p 5544 -U postgres -d iso_run -f "$(dirname "$0")/isolation_test.sql"
