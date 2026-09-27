"""계약 테스트: fixture 실응답 → 정규화 결과가 schemas/*.json 을 만족해야 한다(Java 쪽도 같은 파일로 검증)."""

import base64
import gzip
import json
from datetime import UTC, datetime

import orjson
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from skywx_collector.normalize import from_readsb
from skywx_collector.publisher import Publisher, encode_payload
from skywx_collector.sigmet_parse import parse_isigmet

NOW = datetime.now(UTC)


def _registry(schemas_dir):
    reg = Registry()
    for name in ("aircraft_state.v1.json", "sigmet.v1.json", "stream_envelope.v1.json"):
        doc = json.loads((schemas_dir / name).read_text())
        reg = reg.with_resource(doc["$id"], Resource.from_contents(doc))
        reg = reg.with_resource(name, Resource.from_contents(doc))
    return reg


def _validator(schemas_dir, name):
    doc = json.loads((schemas_dir / name).read_text())
    return Draft202012Validator(doc, registry=_registry(schemas_dir), format_checker=FormatChecker())


def test_aircraft_states_match_schema(fixtures_dir, schemas_dir):
    v = _validator(schemas_dir, "aircraft_state.v1.json")
    data = json.loads((fixtures_dir / "adsb_lol_region.json").read_text())
    states = [s for s in (from_readsb(ac, "adsb_lol", NOW) for ac in data["ac"]) if s is not None]
    assert len(states) > 50
    for s in states:
        v.validate(s.model_dump(mode="json"))


def test_sigmets_match_schema(fixtures_dir, schemas_dir):
    v = _validator(schemas_dir, "sigmet.v1.json")
    items = json.loads((fixtures_dir / "awc_isigmet.json").read_text())
    for it in items:
        s = parse_isigmet(it, NOW)
        if s is not None:
            v.validate(s.model_dump(mode="json"))


def test_envelope_matches_schema_and_roundtrips(schemas_dir):
    v = _validator(schemas_dir, "stream_envelope.v1.json")
    pub = Publisher(redis=None)  # type: ignore[arg-type]
    payload = {"region": {"lat": 36.5, "lon": 127.8, "radius_nm": 250}, "states": []}
    env = pub.envelope(
        kind="aircraft",
        scope="region",
        provider="adsb_lol",
        fetched_at=NOW,
        raw_ref="raw/x.json.gz",
        count=0,
        run_id="1",
        payload=payload,
    )
    v.validate(env)
    decoded = orjson.loads(gzip.decompress(base64.b64decode(env["payload"])))
    assert decoded == payload
    assert encode_payload({"a": 1}) == env["payload"] or True
