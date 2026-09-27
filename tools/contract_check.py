#!/usr/bin/env python3
"""언어 간 계약 검사(14.1): Python 수집기가 fixture 실응답으로 만든 메시지가 schemas/*.json 을 만족하고,
Java 가 참조하는 클래스패스 복사본(apps/api/src/main/resources/schemas)이 루트와 동일한지 확인한다.
CI 와 `make contract` 에서 실행. apps/collector 의 uv 환경에서 실행한다."""
from __future__ import annotations

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
    print("contract check:", "FAILED" if failures else "PASSED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
