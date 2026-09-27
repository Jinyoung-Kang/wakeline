#!/usr/bin/env python3
"""언어 간 계약 검사(14.1): Python 수집기가 fixture 실응답으로 만든 메시지가 schemas/*.json 을 만족하고,
Java 가 참조하는 클래스패스 복사본(apps/api/src/main/resources/schemas)이 루트와 동일한지 확인한다.
CI 와 `make contract` 에서 실행. apps/collector 의 uv 환경에서 실행한다."""
from __future__ import annotations

import asyncio
import base64
import filecmp
import gzip
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "collector"))

from typing import get_args  # noqa: E402

from jsonschema import Draft202012Validator, FormatChecker  # noqa: E402
from referencing import Registry, Resource  # noqa: E402

from wakeline_collector.ais.book import STATE_FIELDS, ShipBook  # noqa: E402
from wakeline_collector.ais.feed import FeedState  # noqa: E402
from wakeline_collector.ais.parse import (  # noqa: E402
    POSITION_CLASS,
    POSITION_SOURCE,
    POSITION_SOURCE_EPFS,
    STATIC_FIELDS,
    SUBSCRIBED_TYPES,
    go_time,
    parse_message,
)
from wakeline_collector.ais.queue import RawQueue  # noqa: E402
from wakeline_collector.ais.sink import AisSink  # noqa: E402
from wakeline_collector.ais.worker import Worker  # noqa: E402
from wakeline_collector.demand import HotCell, parse_cell_key  # noqa: E402
from wakeline_collector.jobs.demand import focus_payload, hot_payload  # noqa: E402
from wakeline_collector.models import Sigmet  # noqa: E402
from wakeline_collector.normalize import from_readsb  # noqa: E402
from wakeline_collector.publisher import Publisher  # noqa: E402
from wakeline_collector.sigmet_parse import parse_airsigmet, parse_isigmet  # noqa: E402

SCHEMAS = ROOT / "schemas"
FIXTURES = ROOT / "fixtures"
COPY = ROOT / "apps" / "api" / "src" / "main" / "resources" / "schemas"


def registry() -> Registry:
    reg = Registry()
    for f in SCHEMAS.glob("*.json"):
        doc = json.loads(f.read_text())
        reg = reg.with_resource(doc["$id"], Resource.from_contents(doc)).with_resource(f.name, Resource.from_contents(doc))
    return reg


def validator(name: str, pointer: str = "") -> Draft202012Validator:
    doc = json.loads((SCHEMAS / name).read_text())
    if pointer:
        sub = doc
        for part in pointer.strip("/").split("/"):
            sub = sub[part]
        sub = {"$id": doc["$id"] + "#" + pointer, "$schema": doc["$schema"], **sub}
        doc = sub
    return Draft202012Validator(doc, registry=registry(), format_checker=FormatChecker())


def main() -> int:
    failures = 0
    now = datetime.now(UTC)
    # 1. 클래스패스 복사본 동기화
    for f in SCHEMAS.glob("*.json"):
        c = COPY / f.name
        if not c.exists() or not filecmp.cmp(f, c, shallow=False):
            print(f"FAIL schema copy out of sync: {c} (run: cp schemas/*.json apps/api/src/main/resources/schemas/)")
            failures += 1
    # 2. 항공기 payload
    pub = Publisher(redis=None)  # type: ignore[arg-type]
    env_v = validator("stream_envelope.v1.json")
    ac_v = validator("stream_envelope.v1.json", "/$defs/aircraft_payload")
    for name, provider in (("adsb_lol_region.json", "adsb_lol"), ("adsb_fi_region.json", "adsb_fi")):
        data = json.loads((FIXTURES / name).read_text())
        states = [s for s in (from_readsb(ac, provider, now) for ac in data["ac"]) if s is not None]
        payload = {"region": {"lat": 36.5, "lon": 127.8, "radius_nm": 250}, "states": [s.model_dump(mode="json") for s in states]}
        env = pub.envelope(kind="aircraft", scope="region", provider=provider, fetched_at=now, raw_ref="fixture", count=len(states), run_id="0", payload=payload)
        errs = list(env_v.iter_errors(env)) + list(ac_v.iter_errors(json.loads(gzip.decompress(base64.b64decode(env["payload"])))))
        print(f"{'FAIL' if errs else 'ok  '} aircraft payload from {name}: {len(states)} states, {len(errs)} schema errors")
        for e in errs[:3]:
            print("     ", e.json_path, e.message[:120])
        failures += bool(errs)
    # 2-1. 지상 고도 정직성(COL-2): readsb 지상 레코드는 alt_ft 를 0 으로 만들지 않는다(null)
    grounded = [s for s in states if s.on_ground]
    fabricated = [s.hex for s in grounded if s.alt_ft is not None]
    print(f"{'FAIL' if fabricated else 'ok  '} ground altitude honesty: {len(grounded)} on_ground states, {len(fabricated)} with alt_ft")
    failures += bool(fabricated)
    # 2-2. 수요 기반 추적(계약 v2 §A2·§B2): focus(requested·missing) · hot(cell·region) payload 와 봉투 scope
    fi = json.loads((FIXTURES / "adsb_fi_region.json").read_text())
    fi_states = [s for s in (from_readsb(ac, "adsb_fi", now) for ac in fi["ac"]) if s is not None]
    requested = [s.hex for s in fi_states[:3]] + ["000001"]
    kept = [s for s in fi_states if s.hex in requested]
    missing = [h for h in requested if h not in {s.hex for s in kept}]
    cell_key = "35.5:139.5:150"
    lat, lon, radius = parse_cell_key(cell_key)  # type: ignore[misc]
    cell = HotCell(cell_key, lat, lon, radius, expires_ms=0.0)
    for scope, payload in (("focus", focus_payload(requested, kept, missing)), ("hot", hot_payload(cell, fi_states))):
        env = pub.envelope(kind="aircraft", scope=scope, provider="adsb_fi", fetched_at=now, raw_ref="fixture", count=len(payload["states"]), payload=payload)
        errs = list(env_v.iter_errors(env)) + list(ac_v.iter_errors(json.loads(gzip.decompress(base64.b64decode(env["payload"])))))
        print(f"{'FAIL' if errs else 'ok  '} aircraft {scope} payload: {len(payload['states'])} states, {len(errs)} schema errors")
        for e in errs[:3]:
            print("     ", e.json_path, e.message[:120])
        failures += bool(errs)
    bad_cell = list(ac_v.iter_errors({"states": [], "cell": "35.3:139.5:150"})) and list(ac_v.iter_errors({"states": [], "requested": ["ABCDEF"]}))
    print(f"{'ok  ' if bad_cell else 'FAIL'} aircraft payload rejects malformed cell / hex")
    failures += not bad_cell
    # 2-3. 봉투 열거값(계약 v2 §B2)
    props = json.loads((SCHEMAS / "stream_envelope.v1.json").read_text())["properties"]
    need_kind, need_scope = {"aircraft", "sigmet", "radar", "ships", "ais_gap"}, {"region", "global", "hot", "focus", "ships", "-"}
    enum_bad = (need_kind - set(props["kind"]["enum"])) | (need_scope - set(props["scope"]["enum"]))
    print(f"{'FAIL' if enum_bad else 'ok  '} envelope kind/scope enums" + (f": missing {sorted(enum_bad)}" if enum_bad else ""))
    failures += bool(enum_bad)
    # 3. SIGMET payload
    sg_v = validator("stream_envelope.v1.json", "/$defs/sigmet_payload")
    intl = [s for s in (parse_isigmet(it, now) for it in json.loads((FIXTURES / "awc_isigmet.json").read_text())) if s]
    us = [s for s in (parse_airsigmet(it, now) for it in json.loads((FIXTURES / "awc_airsigmet.json").read_text())) if s]
    payload = {"sigmets": [s.model_dump(mode="json") for s in intl + us]}
    errs = list(sg_v.iter_errors(payload))
    print(f"{'FAIL' if errs else 'ok  '} sigmet payload: {len(intl)} intl + {len(us)} us, {len(errs)} schema errors")
    failures += bool(errs)
    # 3-1. 고도대 출처(계약 §4): 모든 레코드가 싣고, 스키마 enum 과 모델 Literal 이 같다
    props = json.loads((SCHEMAS / "sigmet.v1.json").read_text())["properties"]
    bad = []
    for fld in ("base_source", "top_source"):
        model_vals = set(get_args(Sigmet.model_fields[fld].annotation))
        if set(props.get(fld, {}).get("enum", [])) != model_vals:
            bad.append(f"{fld}: schema enum != model {sorted(model_vals)}")
    rows = payload["sigmets"]
    missing = sum(1 for d in rows if "base_source" not in d or "top_source" not in d)
    inconsistent = sum(1 for d in rows if (d["top_ft"] is None) != (d.get("top_source") == "unknown"))
    assumed = sum(1 for d in rows if d.get("base_source") == "assumed_surface" and d["base_ft"] != 0)
    if missing or inconsistent or assumed:
        bad.append(f"records missing={missing} top/unknown inconsistent={inconsistent} assumed_surface base!=0={assumed}")
    print(f"{'FAIL' if bad else 'ok  '} sigmet band provenance: " + ("; ".join(bad) if bad else f"{len(rows)} records"))
    failures += bool(bad)
    # 4. 레이더 payload
    rv = json.loads((FIXTURES / "rainviewer_weather_maps.json").read_text())
    rd_v = validator("stream_envelope.v1.json", "/$defs/radar_payload")
    errs = list(rd_v.iter_errors({"host": rv["host"], "generated": rv["generated"], "past": rv["radar"]["past"]}))
    print(f"{'FAIL' if errs else 'ok  '} radar payload: {len(rv['radar']['past'])} frames, {len(errs)} schema errors")
    failures += bool(errs)
    # 5. 선박(AIS, 계약 v2 §B1·§B2): 실수신 fixture 484건 → 실제 발행 경로(worker → ShipBook → AisSink.flush) → 스키마
    failures += check_ships(env_v)
    print("contract check:", "FAILED" if failures else "PASSED")
    return 1 if failures else 0


class _CaptureRedis:
    """AisSink 가 보내는 XADD 를 모은다(Redis 없이 실제 발행 코드를 태운다)."""

    def __init__(self) -> None:
        self.entries: list[dict[str, str]] = []

    async def xadd(self, stream: str, fields: dict[str, str], **_kw: object) -> str:
        self.entries.append(fields)
        return f"{len(self.entries)}-0"


def _decode(fields: dict[str, str]) -> object:
    return json.loads(gzip.decompress(base64.b64decode(fields["payload"])))


def check_ships(env_v: Draft202012Validator) -> int:
    failures = 0
    ships_v = validator("stream_envelope.v1.json", "/$defs/ships_payload")
    gap_v = validator("stream_envelope.v1.json", "/$defs/ais_gap_payload")
    lines = [json.loads(x) for x in (FIXTURES / "ais_east_asia_90s.jsonl").read_text().splitlines() if x.strip()]
    types = {d["MessageType"] for d in lines}
    missing_types = set(SUBSCRIBED_TYPES) - types
    print(f"{'FAIL' if missing_types else 'ok  '} ais fixture covers all subscribed message types: {sorted(types)}")
    failures += bool(missing_types)

    async def run() -> tuple[list[dict[str, str]], Worker]:
        cap = _CaptureRedis()
        q, book, feed = RawQueue(), ShipBook("aisstream"), FeedState("aisstream")
        w = Worker(q, book)
        sink = AisSink(cap, book=book, feed=feed, worker=w, queue=q, provider="aisstream", raw_ref="-")  # type: ignore[arg-type]
        now = datetime.now(UTC).timestamp()
        feed.on_subscribed("18,105,46,150", deflate=True)
        for d in lines:
            d = {**d, "MetaData": {**d["MetaData"], "time_utc": go_time(now + d.get("_recv_offset_s", 0) - 90)}}
            w.handle(json.dumps(d).encode())
            feed.on_message(now)
        feed.gaps.open(now - 60, "server closed (1006)")
        feed.gaps.close(now)
        await sink.flush()
        await sink.publish_gaps()
        return cap.entries, w

    entries, w = asyncio.run(run())
    rejected = {k: v for k, v in w.counts.items() if k in ("json", "shape", "type", "invalid_flag", "mmsi", "time", "position_range", "part")}
    print(f"{'FAIL' if rejected else 'ok  '} ais fixture parse: {w.processed} messages, rejected {rejected or 0}")
    failures += bool(rejected)
    for f in entries:
        payload = _decode(f)
        errs = list(env_v.iter_errors(f)) + list((ships_v if f["kind"] == "ships" else gap_v).iter_errors(payload))
        size = f"{len(payload['ships'])} ships + {len(payload['static'])} static" if f["kind"] == "ships" else "1 gap"  # type: ignore[index]
        print(f"{'FAIL' if errs else 'ok  '} {f['kind']} payload ({size}): {len(errs)} schema errors")
        for e in errs[:3]:
            print("     ", e.json_path, e.message[:120])
        failures += bool(errs)
    if {f["kind"] for f in entries} != {"ships", "ais_gap"}:
        print("FAIL ais entries missing a kind:", [f["kind"] for f in entries])
        failures += 1
    # 정직성: '값 없음' 표기가 null 로 바뀌었다(fixture 의 heading 511 · cog 360 · rot -128 · ETA/IMO/선종/흘수 0)
    ships = [s for f in entries if f["kind"] == "ships" for s in _decode(f)["ships"]]  # type: ignore[index]
    statics = [s for f in entries if f["kind"] == "ships" for s in _decode(f)["static"]]  # type: ignore[index]
    nulls = {k: sum(1 for s in ships if s[k] is None) for k in ("heading_deg", "cog_deg", "rot")}
    snulls = {k: sum(1 for s in statics if s[k] is None) for k in ("imo", "ship_type", "draught_m", "eta_month")}
    sentinel = [s["mmsi"] for s in ships if s["heading_deg"] == 511 or (s["cog_deg"] or 0) >= 360 or s["rot"] == -128]
    print(f"{'FAIL' if sentinel else 'ok  '} ais sentinel honesty: nulls {nulls} · static nulls {snulls}, {len(sentinel)} sentinel values leaked")
    failures += bool(sentinel)
    # 위치 출처(계약 v3 §B): Timestamp 0–59 → epfs, 60(값 없음)·없음 → null. "gnss" 는 더 이상 만들지 않는다
    wrong = []
    for d in lines:
        if d["MessageType"] in POSITION_CLASS:
            ts = d["Message"][d["MessageType"]].get("Timestamp")
            src = parse_message(json.dumps(d).encode()).position.position_source  # type: ignore[union-attr]
            want = POSITION_SOURCE_EPFS if isinstance(ts, int) and 0 <= ts <= 59 else POSITION_SOURCE.get(ts)  # type: ignore[arg-type]
            if src != want:
                wrong.append((ts, src))
    ts60 = sum(1 for d in lines if d["MessageType"] in POSITION_CLASS and d["Message"][d["MessageType"]].get("Timestamp") == 60)
    gnss = sum(1 for s in ships if s["position_source"] == "gnss")
    print(f"{'FAIL' if wrong or gnss else 'ok  '} ais position_source honesty: {ts60} Timestamp-60 reports → null, {len(wrong)} mismatches, {gnss} 'gnss' published")
    failures += bool(wrong) or bool(gnss)
    # 스키마 열거값 = 코드 상수
    st = json.loads((SCHEMAS / "ship_state.v1.json").read_text())
    ss = json.loads((SCHEMAS / "ship_static.v1.json").read_text())
    bad = []
    if tuple(st["required"]) != STATE_FIELDS:
        bad.append("ship_state required != book.STATE_FIELDS")
    # 수집기가 만드는 값 + null(모름) + 배포 전환 중에만 받는 레거시 "gnss"
    ps = st["properties"]["position_source"]
    if ps.get("type") != ["string", "null"] or ps["enum"] != [POSITION_SOURCE_EPFS, *POSITION_SOURCE.values(), "gnss", None]:
        bad.append("position_source enum")
    if set(st["properties"]["msg_type"]["enum"]) != set(POSITION_CLASS) or set(st["properties"]["class"]["enum"]) != set(POSITION_CLASS.values()):
        bad.append("msg_type/class enum")
    if set(ss["required"]) != {"mmsi", *STATIC_FIELDS, "updated_at", "provider"}:
        bad.append("ship_static required != parse.STATIC_FIELDS")
    print(f"{'FAIL' if bad else 'ok  '} ship schema enums/fields match code" + (f": {bad}" if bad else ""))
    failures += bool(bad)
    # 파서 단독: 5개 형식 모두 위치 또는 정적 정보를 만든다
    kinds = {d["MessageType"]: parse_message(json.dumps(d).encode()) for d in lines}
    empty = [t for t, p in kinds.items() if p.position is None and p.static is None]
    print(f"{'FAIL' if empty else 'ok  '} ais parser yields data for every message type" + (f": empty {empty}" if empty else ""))
    failures += bool(empty)
    return failures


if __name__ == "__main__":
    sys.exit(main())
