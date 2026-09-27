#!/bin/bash
# 최초 초기화 1회 실행 (docker-entrypoint-initdb.d). 역할 3개 + 데이터베이스 + PostGIS.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username postgres <<-EOSQL
    CREATE ROLE skywx_migrator LOGIN PASSWORD '${DB_MIGRATOR_PASSWORD}';
    CREATE ROLE skywx_api       LOGIN PASSWORD '${DB_API_PASSWORD}';
    CREATE ROLE skywx_collector LOGIN PASSWORD '${DB_COLLECTOR_PASSWORD}';
    CREATE DATABASE skywx OWNER skywx_migrator;
EOSQL
psql -v ON_ERROR_STOP=1 --username postgres --dbname skywx <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS postgis;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT ALL   ON SCHEMA public TO skywx_migrator;
    GRANT USAGE ON SCHEMA public TO skywx_api, skywx_collector;
    ALTER DATABASE skywx SET timezone TO 'UTC';
EOSQL
