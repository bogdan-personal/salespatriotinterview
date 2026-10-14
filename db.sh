#!/bin/bash
# Starts the Postgres database in Docker and creates the tables.
# Safe to run many times: it starts the container if it exists, creates it if not.
set -e

if sudo docker ps -a --format '{{.Names}}' | grep -q '^dibbs-postgres$'; then
  sudo docker start dibbs-postgres > /dev/null
else
  sudo docker run -d --name dibbs-postgres \
    -e POSTGRES_USER=dibbs -e POSTGRES_PASSWORD=dibbs -e POSTGRES_DB=dibbs \
    -p 5434:5432 postgres:16-alpine > /dev/null
fi

echo "waiting for the database..."
until sudo docker exec dibbs-postgres pg_isready -U dibbs > /dev/null 2>&1; do
  sleep 1
done

sudo docker exec -i dibbs-postgres psql -U dibbs -d dibbs -q < schema.sql
echo "database is ready on localhost:5434 (user dibbs, password dibbs, db dibbs)"
