"""연안 교통량(ADR-023) — 한국해양교통안전공단 실시간 해양교통정보(get_realtime) 응답 해석과 Redis 스냅샷 값.

응답(2026-09-29 사용자 키로 확인): response.header.resultCode("200" 정상) · resultMsg, response.body.items.item[] =
{grid_id(예: "GR4_F2K41_C3"), vmtc(선박 척수), dnsty(밀집도 %)}, body.totalCount, body.regDt("2026-09-29 18:05:05" — KST, 생성 시각).
한 번에 전체가 온다(2026-09-29 numOfRows=6000 → 5,099건 · 2026-09-30 격자가 6,422건으로 늘어 10000 으로 — providers/data_go_kr.KOMSA_ROWS). 5분마다 새 자료.

- 모양이 다른 응답도 읽는다: item 이 객체 하나(항목 1건) · items 가 빈 글자/없음(0건) · items 가 바로 목록. 숫자는 JSON 수 또는 숫자 글자.
  이것은 형식의 관용이지 값의 짐작이 아니다 — 값의 범위(척수 0 이상 정수 · 밀집도 0–100)는 확인한 범위 그대로 검사한다.
- resultCode 가 "200" 이 아니면 KomsaApiError(코드 · 문구). 공공데이터포털 게이트웨이의 XML 오류(OpenAPI_ServiceResponse)도 같은 오류로 —
  returnReasonCode · returnAuthMsg 를 싣는다(키가 등록되지 않음 · 호출 한도 초과 등을 운영 화면에서 바로 알 수 있게).
- regDt 가 없거나 형식이 틀리면 스냅샷 전체를 받지 않는다(시각을 모르는 집계를 '지금'으로 보이지 않는다).
- 항목 하나가 틀리면 그 항목만 뺀다(rejected — 품질 사례). grid_id 는 WFS 요청에 들어가므로 영숫자·밑줄 1–32자만. 같은 grid_id 는 처음 것만.
- 스냅샷 값(Redis wakeline:traffic_grid): 칸 = [grid_no, lat_min, lon_min, 척수, 밀집도 %] — 크기는 늘 0.025°(cell_deg).
  기하를 아는 칸만 싣고, 모르는 칸은 수로만(pending · not_found · off_grid · failed). 개별 선박 위치가 아니다.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import orjson

from wakeline_collector.marine_grid import CELL_DEG, Cell

__all__ = ["CELL_DEG", "KST", "KomsaApiError", "KomsaSnapshot", "TrafficItem", "build_payload", "parse_komsa"]

KST = timezone(timedelta(hours=9))
GRID_ID_RE = re.compile(r"^[A-Za-z0-9_]{1,32}$")
VMTC_MAX = 100_000  # 칸 하나의 척수 상한(형식 검사 — 확인한 최대 102)
REG_DT_FORMAT = "%Y-%m-%d %H:%M:%S"
_XML_TAG = re.compile(rb"<(returnReasonCode|returnAuthMsg|errMsg)>([^<]{0,120})</\1>")


class KomsaApiError(ValueError):
    """공급자가 오류라고 답했다(resultCode ≠ 200 · 포털 게이트웨이 오류). code = 공급자 코드."""

    def __init__(self, code: str, msg: str) -> None:
        super().__init__(f"resultCode {code}: {msg}".strip())
        self.code = code
        self.msg = msg


@dataclass(frozen=True)
class TrafficItem:
    grid_id: str
    vmtc: int
    dnsty: float


@dataclass
class KomsaSnapshot:
    reg_dt: datetime  # KST(+09:00) 시각 — 공급자가 준 벽시계 값
    total_count: int | None
    items: list[TrafficItem]
    rejected: list[dict[str, Any]] = field(default_factory=list)
    duplicates: int = 0


def _gateway_error(raw: bytes) -> KomsaApiError | None:
    if b"OpenAPI_ServiceResponse" not in raw[:512]:
        return None
    found = {m.group(1).decode(): m.group(2).decode("utf-8", "replace").strip() for m in _XML_TAG.finditer(raw[:4096])}
    return KomsaApiError(
        found.get("returnReasonCode", "portal"), f"{found.get('errMsg', '')} {found.get('returnAuthMsg', '')}".strip()
    )


def _int(v: object) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and math.isfinite(v) and v.is_integer():
        return int(v)
    if isinstance(v, str) and re.fullmatch(r"-?\d{1,9}", v.strip()):
        return int(v.strip())
    return None


def _num(v: object) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int | float):
        f = float(v)
    elif isinstance(v, str) and re.fullmatch(r"-?\d{1,6}(\.\d{1,6})?", v.strip()):
        f = float(v.strip())
    else:
        return None
    return f if math.isfinite(f) else None


def _reg_dt(v: object) -> datetime:
    if not isinstance(v, str):
        raise ValueError("regDt missing or not text")
    try:
        return datetime.strptime(v.strip(), REG_DT_FORMAT).replace(tzinfo=KST)
    except ValueError:
        raise ValueError(f"regDt {v[:32]!r} is not 'YYYY-MM-DD HH:MM:SS'") from None


def _items(body: Mapping[str, Any]) -> list[object]:
    items = body.get("items")
    if items is None or items == "":
        return []
    if isinstance(items, list):
        return items
    if isinstance(items, dict):
        it = items.get("item")
        if it is None:
            return []
        return it if isinstance(it, list) else [it]
    raise ValueError(f"body.items is {type(items).__name__}")


def _reject(reason: str, item: object) -> dict[str, Any]:
    """품질 사례(짧게): 사유 + grid_id(글자면 앞 40자)."""
    gid = item.get("grid_id") if isinstance(item, dict) else None
    return {"reason": reason, "grid_id": gid[:40] if isinstance(gid, str) else None}


def parse_komsa(raw: bytes) -> KomsaSnapshot:
    """get_realtime 응답 본문 → 스냅샷. 공급자 오류는 KomsaApiError, 모양 오류는 ValueError."""
    gw = _gateway_error(raw)
    if gw is not None:
        raise gw
    try:
        doc = orjson.loads(raw)
    except orjson.JSONDecodeError:
        raise ValueError("response is not JSON") from None
    resp = doc.get("response") if isinstance(doc, dict) else None
    if not isinstance(resp, dict):
        raise ValueError("no response object")
    header = resp.get("header")
    code = header.get("resultCode") if isinstance(header, dict) else None
    if code is None:
        raise ValueError("no response.header.resultCode")
    if str(code).strip() != "200":
        msg = header.get("resultMsg") if isinstance(header, dict) else None
        raise KomsaApiError(str(code).strip()[:12], str(msg or "")[:120])
    body = resp.get("body")
    if not isinstance(body, dict):
        raise ValueError("no response.body object")
    reg = _reg_dt(body.get("regDt"))
    total = _int(body.get("totalCount"))
    items: list[TrafficItem] = []
    rejected: list[dict[str, Any]] = []
    seen: set[str] = set()
    dups = 0
    for it in _items(body):
        if not isinstance(it, dict):
            rejected.append(_reject("item", it))
            continue
        gid = it.get("grid_id")
        if not isinstance(gid, str) or not GRID_ID_RE.fullmatch(gid):
            rejected.append(_reject("grid_id", it))
            continue
        vmtc = _int(it.get("vmtc"))
        if vmtc is None or not 0 <= vmtc <= VMTC_MAX:
            rejected.append(_reject("vmtc", it))
            continue
        dn = _num(it.get("dnsty"))
        if dn is None or not 0 <= dn <= 100:
            rejected.append(_reject("dnsty", it))
            continue
        if gid in seen:
            dups += 1
            continue
        seen.add(gid)
        items.append(TrafficItem(gid, vmtc, dn))
    return KomsaSnapshot(reg, total if total is not None and total >= 0 else None, items, rejected, dups)


def iso_z(dt: datetime) -> str:
    """UTC ISO-8601(밀리초까지, 'Z')."""
    s = dt.astimezone(UTC).isoformat(timespec="milliseconds")
    s = s.replace("+00:00", "Z")
    return s[:-5] + "Z" if s.endswith(".000Z") else s


def build_payload(
    snap: KomsaSnapshot,
    fetched_at: datetime,
    cells: Mapping[str, Cell],
    negative: Mapping[str, str],
) -> dict[str, Any]:
    """Redis 스냅샷 값(dict — 호출자가 orjson 으로 싣는다). negative = grid_id → 'not_found' | 'off_grid' | 'failed'(기하를 쓰지 않는 칸 —
    failed 는 위치 조회가 거듭 실패해 잠시 묻지 않는 칸이다 — 확인 중(pending)과 따로 센다).
    같은 입력이면 같은 값이다(발행 시각을 싣지 않는다 — api 의 ETag 가 내용이 바뀔 때만 바뀌게. 발행 시각은 heartbeat traffic_grid_at)."""
    out_cells: list[list[Any]] = []
    not_found = off_grid = failed = pending = 0
    for it in sorted(snap.items, key=lambda i: i.grid_id):
        c = cells.get(it.grid_id)
        if c is not None:
            out_cells.append([it.grid_id, round(c.lat_min, 3), round(c.lon_min, 3), it.vmtc, round(it.dnsty, 2)])
            continue
        why = negative.get(it.grid_id)
        if why == "not_found":
            not_found += 1
        elif why == "off_grid":
            off_grid += 1
        elif why == "failed":
            failed += 1
        else:
            pending += 1
    seen = len(snap.items) + len(snap.rejected) + snap.duplicates
    return {
        "v": 1,
        "reg_dt_kst": snap.reg_dt.astimezone(KST).isoformat(),
        "reg_dt_utc": iso_z(snap.reg_dt),
        "fetched_at": iso_z(fetched_at),
        "total": len(snap.items),
        "total_count": snap.total_count,
        "partial": snap.total_count is not None and snap.total_count > seen,
        "rejected": len(snap.rejected),
        "resolved": len(out_cells),
        "unresolved": len(snap.items) - len(out_cells),
        "pending": pending,
        "not_found": not_found,
        "off_grid": off_grid,
        "failed": failed,
        "cell_deg": CELL_DEG,
        "cells": out_cells,
    }
