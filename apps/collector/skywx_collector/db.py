"""수집 전용 DB 역할(skywx_collector)로 ingest 테이블에만 쓴다. 테이블은 api 의 Flyway 가 만든다."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

import asyncpg
import orjson

from skywx_collector.config import settings
from skywx_collector.masking import mask

log = logging.getLogger("db")


class Db:
    def __init__(self) -> None:
        self._pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        self._pool = await asyncpg.create_pool(
            host=settings.db_host,
            port=settings.db_port,
            database=settings.db_name,
            user="skywx_collector",
            password=settings.db_collector_password,
            min_size=1,
            max_size=4,
            command_timeout=10,
            server_settings={"application_name": "skywx-collector", "timezone": "UTC"},
        )

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()

    @property
    def pool(self) -> asyncpg.Pool:
        assert self._pool is not None, "db not connected"
        return self._pool

    async def start_run(self, job: str, provider: str, started_at: datetime) -> int:
        return await self.pool.fetchval(
            "INSERT INTO ingest_run (job, provider, started_at, status) VALUES ($1,$2,$3,'running') RETURNING id",
            job,
            provider,
            started_at,
        )

    async def finish_run(
        self,
        run_id: int,
        *,
        status: str,
        http_status: int | None,
        latency_ms: int | None,
        records_in: int,
        records_quarantined: int,
        raw_ref: str | None,
        error_text: str | None,
    ) -> None:
        await self.pool.execute(
            """UPDATE ingest_run SET finished_at=$2, status=$3, http_status=$4, latency_ms=$5,
                   records_in=$6, records_quarantined=$7, raw_ref=$8, error_text=$9 WHERE id=$1""",
            run_id,
            datetime.now(UTC),
            status,
            http_status,
            latency_ms,
            records_in,
            records_quarantined,
            raw_ref,
            mask(error_text),
        )

    async def quality_events(self, run_id: int, events: list[tuple[str, str | None, dict[str, Any]]]) -> None:
        if not events:
            return
        # 규칙별 대표 사례 최대 20건만 개별 저장, 나머지는 건수로 집계(운영 화면은 규칙별 건수 + 최근 사례)
        per_rule: dict[str, int] = {}
        rows: list[tuple[int, str, str | None, str]] = []
        for rule, hex_, detail in events:
            per_rule[rule] = per_rule.get(rule, 0) + 1
            if per_rule[rule] <= 20:
                rows.append((run_id, rule, hex_, orjson.dumps(detail).decode()))
        await self.pool.executemany("INSERT INTO quality_event (run_id, rule, hex, detail) VALUES ($1,$2,$3,$4::jsonb)", rows)
        await self.pool.executemany(
            """INSERT INTO quality_rule_count (day, rule, count) VALUES (CURRENT_DATE, $1, $2)
               ON CONFLICT (day, rule) DO UPDATE SET count = quality_rule_count.count + EXCLUDED.count""",
            [(rule, n) for rule, n in per_rule.items()],
        )

    async def upsert_airports(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        await self.pool.executemany(
            """INSERT INTO airport (icao, iata, name, country, geom, elev_ft, watched, updated_at)
               VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($5,$6),4326), $7, true, now())
               ON CONFLICT (icao) DO UPDATE SET name=EXCLUDED.name, geom=EXCLUDED.geom, elev_ft=EXCLUDED.elev_ft,
                   country=COALESCE(EXCLUDED.country, airport.country), updated_at=now()""",
            [(r["icao"], r.get("iata"), r.get("name"), r.get("country"), r["lon"], r["lat"], r.get("elev_ft")) for r in rows],
        )

    async def upsert_metar(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        await self.pool.executemany(
            """INSERT INTO metar_obs (icao, obs_time, raw, temp_c, dewp_c, wind_dir, wind_kt, vis_sm, vis_raw, ceiling_ft,
                                      flight_cat, flight_cat_source, wx_string, taf_raw, provider, fetched_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
               ON CONFLICT (icao, obs_time) DO UPDATE SET taf_raw=EXCLUDED.taf_raw, fetched_at=EXCLUDED.fetched_at""",
            [
                (
                    r["icao"],
                    r["obs_time"],
                    r["raw"],
                    r.get("temp_c"),
                    r.get("dewp_c"),
                    r.get("wind_dir"),
                    r.get("wind_kt"),
                    r.get("vis_sm"),
                    r.get("vis_raw"),
                    r.get("ceiling_ft"),
                    r.get("flight_cat"),
                    r.get("flight_cat_source"),
                    r.get("wx_string"),
                    r.get("taf_raw"),
                    r["provider"],
                    r["fetched_at"],
                )
                for r in rows
            ],
        )

    async def insert_radar_frames(self, host: str, frames: list[dict[str, Any]], fetched_at: datetime) -> None:
        if not frames:
            return
        await self.pool.executemany(
            """INSERT INTO radar_frame (frame_time, host, path, fetched_at) VALUES (to_timestamp($1), $2, $3, $4)
               ON CONFLICT (frame_time) DO NOTHING""",
            [(int(f["time"]), host, f["path"], fetched_at) for f in frames],
        )

    async def upsert_budget_day(self, provider: str, day: datetime, used: int, limit: int) -> None:
        await self.pool.execute(
            """INSERT INTO provider_budget_day (provider, day, calls, limit_value) VALUES ($1,$2,$3,$4)
               ON CONFLICT (provider, day) DO UPDATE SET calls=EXCLUDED.calls, limit_value=EXCLUDED.limit_value""",
            provider,
            day.date(),
            used,
            limit,
        )
