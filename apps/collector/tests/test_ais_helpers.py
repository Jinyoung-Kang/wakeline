"""AIS 시험 공용 도구(시험 함수 없음): fixture 읽기, 합성 메시지, 스키마 검증기 — 외부 호출 없음."""

from __future__ import annotations

import base64
import gzip
import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "fixtures" / "ais_east_asia_90s.jsonl"
SCHEMAS = ROOT / "schemas"
T0 = "2026-09-27 16:29:43.949762231 +0000 UTC"
T0_EPOCH = 1790526583.949762


def fixture_docs() -> list[dict[str, Any]]:
    return [json.loads(line) for line in FIXTURE.read_text().splitlines() if line.strip()]


def position(
    mmsi: int = 440091020, *, mtype: str = "PositionReport", time_utc: str = T0, meta_mmsi: Any = None, **body: Any
) -> dict:
    b = {
        "MessageID": 1,
        "UserID": mmsi,
        "Valid": True,
        "NavigationalStatus": 0,
        "RateOfTurn": 0,
        "Sog": 10.0,
        "Longitude": 126.5,
        "Latitude": 37.4,
        "Cog": 90.0,
        "TrueHeading": 91,
        "Timestamp": 43,
    }
    if mtype != "PositionReport":
        for k in ("NavigationalStatus", "RateOfTurn"):
            b.pop(k)
    b.update(body)
    meta = {
        "MMSI": mmsi if meta_mmsi is None else meta_mmsi,
        "ShipName": "TEST",
        "latitude": 37.4,
        "longitude": 126.5,
        "time_utc": time_utc,
    }
    return {"MetaData": meta, "MessageType": mtype, "Message": {mtype: b}}


def static5(mmsi: int = 431009876, *, time_utc: str = T0, **body: Any) -> dict:
    b = {
        "AisVersion": 2,
        "CallSign": "JD4188 ",
        "Destination": "JP TMK E            ",
        "Dimension": {"A": 47, "B": 120, "C": 13, "D": 14},
        "Dte": False,
        "Eta": {"Day": 30, "Hour": 6, "Minute": 0, "Month": 9},
        "FixType": 1,
        "ImoNumber": 9810836,
        "MaximumStaticDraught": 7.3,
        "MessageID": 5,
        "Name": "HIMAWARI8           ",
        "RepeatIndicator": 0,
        "Spare": False,
        "Type": 70,
        "UserID": mmsi,
        "Valid": True,
    }
    b.update(body)
    return {"MetaData": {"MMSI": mmsi, "time_utc": time_utc}, "MessageType": "ShipStaticData", "Message": {"ShipStaticData": b}}


def static24(mmsi: int = 416009981, *, part_b: bool, time_utc: str = T0, name: str = "BLUE HOLE", **rep_b: Any) -> dict:
    b = {
        "MessageID": 24,
        "PartNumber": part_b,
        "RepeatIndicator": 0,
        "ReportA": {"Name": name if not part_b else "", "Valid": not part_b},
        "ReportB": {
            "CallSign": "BX12",
            "Dimension": {"A": 10, "B": 5, "C": 2, "D": 3},
            "FixType": 1,
            "ShipType": 37,
            "Spare": 0,
            "Valid": part_b,
            "VenderIDModel": 0,
            "VenderIDSerial": 0,
            "VendorIDName": "",
            **rep_b,
        },
        "Reserved": 0,
        "UserID": mmsi,
        "Valid": True,
    }
    return {
        "MetaData": {"MMSI": mmsi, "time_utc": time_utc},
        "MessageType": "StaticDataReport",
        "Message": {"StaticDataReport": b},
    }


def dumps(doc: dict) -> bytes:
    return json.dumps(doc).encode()


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
        doc = {"$id": doc["$id"] + "#" + pointer, "$schema": doc["$schema"], **sub}
    return Draft202012Validator(doc, registry=registry(), format_checker=FormatChecker())


def decode(fields: dict[str, str]) -> Any:
    return json.loads(gzip.decompress(base64.b64decode(fields["payload"])))
