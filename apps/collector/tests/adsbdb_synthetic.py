"""adsbdb `/v0/callsign/{CALLSIGN}` 응답 모양의 합성 자료(계약 v4 §A). 실제 노선 자료가 아니다 — 약관상 실제 값은 저장소에 두지 않는다.

공항·항공사 이름과 코드는 지어낸 값이다(ZZ… 코드, 'Synthetic …' 이름, 국가 코드 ZZ).
"""

from __future__ import annotations

import copy
from typing import Any

import orjson

AIRPORT_A: dict[str, Any] = {
    "country_iso_name": "ZZ",
    "country_name": "Testland",
    "elevation": 12,
    "iata_code": "ZZA",
    "icao_code": "ZZAA",
    "latitude": 10.5,
    "longitude": 20.25,
    "municipality": "Alpha Town",
    "name": "Synthetic Field Alpha",
}
AIRPORT_B: dict[str, Any] = {
    "country_iso_name": "ZZ",
    "country_name": "Testland",
    "elevation": 340,
    "iata_code": "ZZB",
    "icao_code": "ZZBB",
    "latitude": -12.75,
    "longitude": 150.125,
    "municipality": "Beta City",
    "name": "Synthetic Field Beta",
}
AIRPORT_C: dict[str, Any] = {
    "country_iso_name": "ZZ",
    "country_name": "Testland",
    "elevation": 0,
    "iata_code": "ZZC",
    "icao_code": "ZZCC",
    "latitude": 1.0,
    "longitude": 100.0,
    "municipality": "Gamma Port",
    "name": "Synthetic Field Gamma",
}
AIRLINE: dict[str, Any] = {
    "name": "Synthetic Air",
    "icao": "ZZX",
    "iata": "Z9",
    "country": "Testland",
    "country_iso": "ZZ",
    "callsign": "SYNTHETIC",
}


def flightroute(callsign: str = "ZZX123", *, midpoint: bool = False, **over: Any) -> dict[str, Any]:
    fr: dict[str, Any] = {
        "callsign": callsign,
        "callsign_icao": callsign,
        "callsign_iata": None,
        "airline": copy.deepcopy(AIRLINE),
        "origin": copy.deepcopy(AIRPORT_A),
        "destination": copy.deepcopy(AIRPORT_B),
    }
    if midpoint:
        fr["midpoint"] = copy.deepcopy(AIRPORT_C)
    fr.update(over)
    return {"response": {"flightroute": fr}}


def body(doc: Any) -> bytes:
    return orjson.dumps(doc)


UNKNOWN = {"response": "unknown callsign"}
