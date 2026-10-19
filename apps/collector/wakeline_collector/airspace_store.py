"""공역 차수 쓰기(ADR-034) — tools.airspace_import 가 해석한 결과(airspace.ParseResult)를 한 트랜잭션으로 V18 표에 넣고 켠다.

- 같은 원본(SHA-256)이 이미 있으면 새로 넣지 않는다: 켜져 있으면 그대로, 꺼져 있으면 그 차수를 다시 켠다(옛 차수로 되돌리기).
- 도형은 PostGIS 가 검사한다: 유효하지 않은 도형은 ST_MakeValid 로 고치고(같은 차원만 남김), 고친 결과가 비면 그 도형은 넣지 않는다(수를 보고한다).
- 새 차수를 다 넣은 뒤 옛 차수를 끄고 새 차수를 켠다 — 같은 트랜잭션이라 api 는 반쯤 들어간 차수를 보지 않는다. 넣은 도형이 0개면 켜지 않는다(되돌림).
- 옛 차수는 지우지 않는다(옛 알림이 가리킨다 — V19).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import orjson

from wakeline_collector.airspace import ParseResult

IMPORT_TIMEOUT_S = 120.0
DISPLAY_TOLERANCE_DEG = 0.0005  # 표시용 단순화(약 50 m) — 판정은 원래 도형


class AirspaceImportError(RuntimeError):
    pass


@dataclass(frozen=True)
class ImportReport:
    edition_id: int
    status: str  # imported | already_active | reactivated
    inserted: int = 0
    fixed: int = 0
    dropped: int = 0
    previous_active: int | None = None


_INSERT = """
WITH src AS (
  SELECT * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
                       $11::text[], $12::int[], $13::text[], $14::text[], $15::int[], $16::text[], $17::text[], $18::text[])
    AS t(category, type_ko, folder, type_code, ident, name, class_code, remarks, gfid,
         kind, lower_ft, lower_basis, lower_raw, upper_ft, upper_basis, upper_raw, wkt)
), g AS (
  SELECT src.*, CASE WHEN ST_IsValid(r.raw) THEN r.raw
                     ELSE ST_CollectionExtract(ST_MakeValid(r.raw), CASE WHEN src.kind = 'polygon' THEN 3 ELSE 2 END) END AS geom
  FROM src CROSS JOIN LATERAL (SELECT ST_GeomFromText(src.wkt, 4326) AS raw) r
)
INSERT INTO airspace (edition_id, category, type_ko, folder, type_code, ident, name, class_code, remarks, gfid,
                      kind, lower_ft, lower_basis, lower_raw, upper_ft, upper_basis, upper_raw, geom, geom_display)
SELECT $1, category, type_ko, folder, type_code, ident, name, class_code, remarks, gfid,
       kind, lower_ft, lower_basis, lower_raw, upper_ft, upper_basis, upper_raw, geom, ST_SimplifyPreserveTopology(geom, $19)
FROM g WHERE NOT ST_IsEmpty(geom)
"""


def _columns(res: ParseResult) -> list[list[Any]]:
    fs = res.features
    return [
        [f.category for f in fs],
        [f.type_ko for f in fs],
        [f.folder for f in fs],
        [f.type_code for f in fs],
        [f.ident for f in fs],
        [f.name for f in fs],
        [f.class_code for f in fs],
        [f.remarks for f in fs],
        [f.gfid for f in fs],
        [f.kind for f in fs],
        [f.lower.ft for f in fs],
        [f.lower.basis for f in fs],
        [f.lower.raw for f in fs],
        [f.upper.ft for f in fs],
        [f.upper.basis for f in fs],
        [f.upper.raw for f in fs],
        [f.wkt for f in fs],
    ]


async def import_edition(pool: Any, *, label: str, sha256: str, res: ParseResult) -> ImportReport:
    """한 트랜잭션으로 넣고 켠다(모듈 설명). 트랜잭션 전체가 상한 IMPORT_TIMEOUT_S 를 넘기면 끊는다(풀이 연결을 버린다 — 서버가 되돌린다).

    모든 도형을 PostGIS 로 검사하는 두 문장(고친 도형 셈 · _INSERT)은 timeout 으로 그 상한의 남은 시간을 받는다 — 주지 않으면 asyncpg 가 풀의
    command_timeout(db.OP_TIMEOUT_S 10 s)을 써서 점이 많은 차수 · 느린 DB 에서 문장 하나가 10 s 를 넘으면 상한 전에 끊겼다. 한 행 · 색인으로 읽고
    쓰는 나머지 문장은 풀의 문장 상한 그대로다. 문장의 시간 초과로 끊겨도 바깥 wait_for 의 취소로 끊겨도 감싼 풀(db._GuardedPool)이 ROLLBACK 을
    기다리지 않고 연결을 버린다(VERIFICATION #111).
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + IMPORT_TIMEOUT_S

    def left() -> float:
        return deadline - loop.time()  # 0 이하면 asyncpg 가 보내지 않고 TimeoutError

    async def txn() -> ImportReport:
        async with pool.acquire() as con, con.transaction():
            row = await con.fetchrow("SELECT id, active FROM airspace_edition WHERE source_sha256 = $1", sha256)
            prev = await con.fetchval("SELECT id FROM airspace_edition WHERE active")
            if row is not None:
                if row["active"]:
                    return ImportReport(row["id"], "already_active", previous_active=prev)
                await con.execute("UPDATE airspace_edition SET active = false WHERE active")
                await con.execute("UPDATE airspace_edition SET active = true WHERE id = $1", row["id"])
                return ImportReport(row["id"], "reactivated", previous_active=prev)
            eid = await con.fetchval(
                """INSERT INTO airspace_edition (label, document_name, source_sha256, counts, skipped)
                   VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb) RETURNING id""",
                label,
                res.document_name,
                sha256,
            )
            cols = _columns(res)
            fixed = await con.fetchval(
                "SELECT count(*) FROM unnest($1::text[]) w WHERE NOT ST_IsValid(ST_GeomFromText(w, 4326))",
                cols[-1],
                timeout=left(),
            )
            status = await con.execute(_INSERT, eid, *cols, DISPLAY_TOLERANCE_DEG, timeout=left())
            inserted = int(status.rsplit(" ", 1)[-1])
            dropped = len(res.features) - inserted
            if inserted == 0:
                raise AirspaceImportError("no geometry was inserted — the edition is not activated")
            counts = {r["category"]: r["n"] for r in await con.fetch(
                "SELECT category, count(*)::int AS n FROM airspace WHERE edition_id = $1 GROUP BY 1 ORDER BY 1", eid
            )}  # fmt: skip
            skipped = dict(res.skipped)
            if dropped:
                skipped["empty after ST_MakeValid"] = dropped
            await con.execute(
                "UPDATE airspace_edition SET counts = $2::jsonb, skipped = $3::jsonb WHERE id = $1",
                eid,
                orjson.dumps(counts).decode(),
                orjson.dumps(skipped).decode(),
            )
            await con.execute("UPDATE airspace_edition SET active = false WHERE active")
            await con.execute("UPDATE airspace_edition SET active = true WHERE id = $1", eid)
            return ImportReport(eid, "imported", inserted, int(fixed), dropped, prev)

    return await asyncio.wait_for(txn(), IMPORT_TIMEOUT_S)
