#!/bin/bash
# 최초 초기화 1회 실행 (docker-entrypoint-initdb.d). 역할 3개 + 데이터베이스 + PostGIS.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username postgres <<-EOSQL
    CREATE ROLE wakeline_migrator LOGIN PASSWORD '${DB_MIGRATOR_PASSWORD}';
    CREATE ROLE wakeline_api       LOGIN PASSWORD '${DB_API_PASSWORD}';
    CREATE ROLE wakeline_collector LOGIN PASSWORD '${DB_COLLECTOR_PASSWORD}';
    CREATE DATABASE wakeline OWNER wakeline_migrator;
EOSQL
psql -v ON_ERROR_STOP=1 --username postgres --dbname wakeline <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS postgis;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT ALL   ON SCHEMA public TO wakeline_migrator;
    GRANT USAGE ON SCHEMA public TO wakeline_api, wakeline_collector;
    ALTER DATABASE wakeline SET timezone TO 'UTC';
EOSQL
