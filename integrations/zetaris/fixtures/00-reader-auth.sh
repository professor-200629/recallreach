#!/bin/sh
# Lets the read-only fixture login (recallreach_reader) connect without a password, so the
# Zetaris datasource definitions carry no secret. It can only SELECT fictional demo tables.
# Every other role, including the postgres superuser, keeps password authentication.
# Runs once, when the container first initialises its data directory.
set -e
sed -i '1i host all recallreach_reader all trust' "$PGDATA/pg_hba.conf"
