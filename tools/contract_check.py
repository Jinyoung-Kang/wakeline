#!/usr/bin/env python3
"""언어 간 계약 검사(14.1): Python 수집기가 fixture 실응답으로 만든 메시지가 schemas/*.json 을 만족하고,
Java 가 참조하는 클래스패스 복사본(apps/api/src/main/resources/schemas)이 루트와 동일한지 확인한다.
CI 와 `make contract` 에서 실행. apps/collector 의 uv 환경에서 실행한다."""

from __future__ import annotations

import asyncio
import base64
import filecmp
import gzip
import io
import json
import logging
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "collector"))

from typing import get_args  # noqa: E402

from jsonschema import Draft202012Validator, FormatChecker  # noqa: E402
from referencing import Registry, Resource  # noqa: E402

from wakeline_collector.ais.bbox import SCOPE_RE, format_bboxes, parse_shards  # noqa: E402
from wakeline_collector.ais.book import STATE_FIELDS, ShipBook  # noqa: E402
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
from wakeline_collector.ais.shards import SHARD_FIELDS, ShardSet  # noqa: E402
from wakeline_collector.ais.sink import AisSink  # noqa: E402
from wakeline_collector.ais.worker import Worker  # noqa: E402
from wakeline_collector.demand import HotCell, parse_cell_key  # noqa: E402
from wakeline_collector.jobs.demand import focus_payload, hot_payload  # noqa: E402
from wakeline_collector.logsink import ENTRY_MAX_BYTES, LogSink  # noqa: E402
from wakeline_collector.masking import _SECRETS, LOG_LIMIT, install_log_masking, mask, register_secrets  # noqa: E402
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
        env = pub.envelope(
            kind="aircraft",
            scope="region",
            provider=provider,
            fetched_at=now,
            raw_ref="fixture",
            count=len(states),
            run_id="0",
            payload=payload,
        )
        errs = list(env_v.iter_errors(env)) + list(
            ac_v.iter_errors(json.loads(gzip.decompress(base64.b64decode(env["payload"]))))
        )
        print(f"{'FAIL' if errs else 'ok  '} aircraft payload from {name}: {len(states)} states, {len(errs)} schema errors")
        for e in errs[:3]:
            print("     ", e.json_path, e.message[:120])
        failures += bool(errs)
    # 2-1. 지상 고도 정직성(COL-2): readsb 지상 레코드는 alt_ft 를 0 으로 만들지 않는다(null)
    grounded = [s for s in states if s.on_ground]
    fabricated = [s.hex for s in grounded if s.alt_ft is not None]
    print(
        f"{'FAIL' if fabricated else 'ok  '} ground altitude honesty: {len(grounded)} on_ground states, {len(fabricated)} with alt_ft"
    )
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
        env = pub.envelope(
            kind="aircraft",
            scope=scope,
            provider="adsb_fi",
            fetched_at=now,
            raw_ref="fixture",
            count=len(payload["states"]),
            payload=payload,
        )
        errs = list(env_v.iter_errors(env)) + list(
            ac_v.iter_errors(json.loads(gzip.decompress(base64.b64decode(env["payload"]))))
        )
        print(
            f"{'FAIL' if errs else 'ok  '} aircraft {scope} payload: {len(payload['states'])} states, {len(errs)} schema errors"
        )
        for e in errs[:3]:
            print("     ", e.json_path, e.message[:120])
        failures += bool(errs)
    bad_cell = list(ac_v.iter_errors({"states": [], "cell": "35.3:139.5:150"})) and list(
        ac_v.iter_errors({"states": [], "requested": ["ABCDEF"]})
    )
    print(f"{'ok  ' if bad_cell else 'FAIL'} aircraft payload rejects malformed cell / hex")
    failures += not bad_cell
    # 2-3. 봉투 열거값(계약 v2 §B2)
    props = json.loads((SCHEMAS / "stream_envelope.v1.json").read_text())["properties"]
    need_kind, need_scope = (
        {"aircraft", "sigmet", "radar", "ships", "ais_gap"},
        {"region", "global", "hot", "focus", "ships", "-"},
    )
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
    # 6. 시스템 로그(계약 v5 §C): 로그 싱크가 만든 LogEvent · 언어 간 가림 벡터
    failures += check_logs()
    # 7. WS 메시지(계약 v5 §E1 · ADR-020): api 시험이 실제 빌더로 만든 웹 fixture 를 Python 으로도 같은 스키마로
    failures += check_ws_samples()
    print("contract check:", "FAILED" if failures else "PASSED")
    return 1 if failures else 0


class _CaptureRedis:
    """AisSink · LogSink 가 보내는 XADD 를 모은다(Redis 없이 실제 발행 코드를 태운다). LogSink 는 파이프라인으로 보낸다."""

    def __init__(self) -> None:
        self.entries: list[dict[str, str]] = []
        self.xadd_kw: list[dict[str, object]] = []

    async def xadd(self, stream: str, fields: dict[str, str], **kw: object) -> str:
        self.entries.append(fields)
        self.xadd_kw.append({"stream": stream, **kw})
        return f"{len(self.entries)}-0"

    def pipeline(self, transaction: bool = False) -> _CapturePipeline:
        return _CapturePipeline(self)


class _CapturePipeline:
    def __init__(self, r: _CaptureRedis) -> None:
        self._r, self._ops = r, []  # type: list[tuple[str, dict[str, str], dict[str, object]]]

    def xadd(self, stream: str, fields: dict[str, str], **kw: object) -> _CapturePipeline:
        self._ops.append((stream, fields, kw))
        return self

    async def execute(self) -> list[str]:
        return [await self._r.xadd(stream, fields, **kw) for stream, fields, kw in self._ops]


# LogEvent.ts(UTC, 밀리초). FormatChecker 는 date-time 을 보지 않는다(rfc3339 검사기가 설치돼 있지 않다) — 직접 본다
TS_MS_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def check_logs() -> int:
    """계약 v5 §C1 · §C2 · §C5: collector · ais 의 로그 싱크(실제 LogSink 코드)가 만든 항목이 log_event.v1.json 을 만족하고,
    직렬화 8 KiB 안이며(넘는 스택은 잘림 표시), 비밀값(모양 · 등록한 값)이 없고, XADD 가 wakeline:logs MAXLEN ~ 3000 * e 인지.
    그리고 언어 간 가림 벡터(schemas/vectors/masking-cases.v1.json)를 Python 가림이 글자 하나까지 맞추는지,
    언어 간 억제 벡터(schemas/vectors/log-suppression.v1.json, §G9)가 있고 모양이 맞는지."""
    failures = 0
    log_v = validator("log_event.v1.json")
    secret = "Zq9-contract-registered-secret"  # noqa: S105 — 가짜 값(등록한 비밀값이 가려지는지 보는 표본)
    register_secrets(secret)
    cap = _CaptureRedis()

    def deep(n: int, what: str) -> None:
        if n == 0:
            raise RuntimeError(f"upstream echoed {what} and token=tok_contract_2 " + "z" * 3000)
        deep(n - 1, what)

    try:
        for service in ("collector", "ais"):
            sink = LogSink(service, cap)
            lg = logging.getLogger(f"contract.logs.{service}")
            lg.handlers[:], lg.propagate = [sink], False
            lg.setLevel(logging.DEBUG)
            lg.info("not shipped (INFO)")
            lg.warning("region poll slow: %d ms (token=%s)", 1234, "tok_contract_1")
            try:
                deep(150, secret)
            except RuntimeError as e:
                lg.error("kma radar failed %s", "q" * 6000, exc_info=e)
            asyncio.run(sink.send_pending())
            lg.handlers.clear()
    finally:
        _SECRETS.discard(secret)
    events = []
    for f in cap.entries:
        raw = f.get("e", "")
        ev = json.loads(raw)
        events.append(ev)
        errs = list(log_v.iter_errors(ev))
        size = len(raw.encode("utf-8"))
        leaked = [x for x in (secret, "tok_contract_1", "tok_contract_2") if x in raw]
        bad = errs or size > ENTRY_MAX_BYTES or leaked or list(f) != ["e"] or not TS_MS_UTC.match(ev.get("ts", ""))
        print(
            f"{'FAIL' if bad else 'ok  '} log event {ev.get('service')}/{ev.get('level')} "
            f"(exception {'yes' if ev.get('exception') else 'null'}): {size} bytes, {len(errs)} schema errors, leaked {leaked}"
        )
        for e in errs[:3]:
            print("     ", e.json_path, e.message[:120])
        failures += bool(bad)
    shape = [(e.get("service"), e.get("level")) for e in events]
    stack_cut = [e for e in events if e.get("exception") and "…(잘림 " in e["exception"]["stack"]]
    kw_ok = all(k == {"stream": "wakeline:logs", "maxlen": 3000, "approximate": True} for k in cap.xadd_kw)
    bad = (
        shape != [("collector", "WARN"), ("collector", "ERROR"), ("ais", "WARN"), ("ais", "ERROR")]
        or len(stack_cut) != 2
        or not kw_ok
    )
    print(
        f"{'FAIL' if bad else 'ok  '} log sink: entries {shape}, oversized stacks cut with marker {len(stack_cut)}/2, "
        f"XADD wakeline:logs MAXLEN ~ 3000 {kw_ok}"
    )
    failures += bool(bad)
    failures += check_log_cut_marker(log_v)
    vectors = json.loads((SCHEMAS / "vectors" / "masking-cases.v1.json").read_text(encoding="utf-8"))
    wrong = [c["input"] for c in vectors["cases"] if mask(c["input"], vectors["limit"]) != c["expected"]]
    print(
        f"{'FAIL' if wrong else 'ok  '} masking vectors (v{vectors['version']}): {len(vectors['cases'])} cases, {len(wrong)} mismatches"
    )
    for w in wrong[:3]:
        print("     ", w[:120])
    failures += bool(wrong)
    failures += check_log_suppression_vectors()
    return failures


LOG_SUPPRESSION_VECTORS = SCHEMAS / "vectors" / "log-suppression.v1.json"
_STEP_KEYS = {"at_ms", "do", "fp", "emit", "entries", "suppressed"}


def _int(v: object) -> bool:
    """정수(불리언 제외)."""
    return isinstance(v, int) and not isinstance(v, bool)


def _nat(v: object) -> bool:
    """0 이상의 정수(불리언 제외)."""
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def log_suppression_vector_problems(doc: object) -> list[str]:
    """계약 v5 §G9: 언어 간 억제 벡터의 모양 — 단계 동작 · 시각 순서 · emit 의 발생 번호 · 누계 · 마지막 close · 불변식
    (close 뒤 항목 수 + suppressed 합 = 발생 수). 문제 목록(없으면 빈 목록). 벡터 파일은 스키마가 아니라 $id 가 없다."""
    if not isinstance(doc, dict):
        return ["top level: not an object"]
    out: list[str] = []
    if doc.get("version") != 1:
        out.append(f"version: {doc.get('version')!r} (want 1)")
    if not (_nat(doc.get("window_ms")) and doc["window_ms"] > 0):
        out.append(f"window_ms: {doc.get('window_ms')!r} (want a positive integer)")
    cases = doc.get("cases")
    if not isinstance(cases, list) or not cases:
        return [*out, "cases: missing or empty"]
    names: set[str] = set()
    for ci, case in enumerate(cases):
        where = f"cases[{ci}]"
        if not isinstance(case, dict) or not isinstance(case.get("name"), str) or not case["name"].strip():
            out.append(f"{where}: needs a name")
            continue
        where = f"case {case['name']!r}"
        if case["name"] in names:
            out.append(f"{where}: duplicate name")
        names.add(case["name"])
        steps = case.get("steps")
        if not isinstance(steps, list) or not steps:
            out.append(f"{where}: steps missing or empty")
            continue
        occurrences = entries = suppressed = 0
        last_at = -1
        emitted: set[int] = set()
        for si, step in enumerate(steps):
            at = f"{where} step {si}"
            if not isinstance(step, dict):
                out.append(f"{at}: not an object")
                continue
            extra = set(step) - _STEP_KEYS
            if extra:
                out.append(f"{at}: unknown key(s) {sorted(extra)}")
            do = step.get("do")
            if do not in ("occur", "tick", "close"):
                out.append(f"{at}: do {do!r} (want occur | tick | close)")
            if not _nat(step.get("at_ms")) or step["at_ms"] < last_at:
                out.append(f"{at}: at_ms {step.get('at_ms')!r} goes back or is not a non-negative integer")
            else:
                last_at = step["at_ms"]
            if "fp" in step and (do != "occur" or not isinstance(step["fp"], str) or not step["fp"]):
                out.append(f"{at}: fp only names the fingerprint of an occur step")
            if do == "close" and si != len(steps) - 1:
                out.append(f"{at}: close must be the last step")
            if do == "occur":
                occurrences += 1
            emit = step.get("emit")
            if not isinstance(emit, list):
                out.append(f"{at}: emit must be a list")
                emit = []
            for e in emit:
                if not (isinstance(e, list) and len(e) == 2 and _nat(e[0]) and _int(e[1])):
                    out.append(f"{at}: emit item {e!r} is not [occurrence, suppressed]")
                    continue
                i, n = e
                if n < 0:
                    out.append(f"{at}: emit {e!r} has negative suppressed")
                if i >= occurrences:
                    out.append(f"{at}: emit {e!r} names occurrence {i}, only {occurrences} so far")
                elif do == "occur" and i != occurrences - 1:
                    out.append(f"{at}: an occur step can only emit its own occurrence ({occurrences - 1}), not {i}")
                if i in emitted:
                    out.append(f"{at}: occurrence {i} emitted twice")
                emitted.add(i)
                entries += 1
                suppressed += n
            if do == "occur" and len(emit) > 1:
                out.append(f"{at}: an occur step emits at most one entry")
            if step.get("entries") != entries:
                out.append(f"{at}: entries {step.get('entries')!r}, running total of emit is {entries}")
            if step.get("suppressed") != suppressed:
                out.append(f"{at}: suppressed {step.get('suppressed')!r}, running total of emit is {suppressed}")
        if not isinstance(steps[-1], dict) or steps[-1].get("do") != "close":
            out.append(f"{where}: the last step must be close")
        elif entries + suppressed != occurrences:
            out.append(f"{where}: invariant — entries {entries} + suppressed {suppressed} != occurrences {occurrences}")
    return out


def check_log_suppression_vectors() -> int:
    """계약 v5 §G9: schemas/vectors/log-suppression.v1.json 이 있고 모양이 맞는지(api LogSinkTest · collector test_logsink 가 같은 파일을 읽는다)."""
    if not LOG_SUPPRESSION_VECTORS.exists():
        print(f"FAIL log suppression vectors: {LOG_SUPPRESSION_VECTORS.relative_to(ROOT)} is missing")
        return 1
    try:
        doc = json.loads(LOG_SUPPRESSION_VECTORS.read_text(encoding="utf-8"))
    except ValueError as e:
        print(f"FAIL log suppression vectors: not JSON ({e})")
        return 1
    problems = log_suppression_vector_problems(doc)
    cases = doc.get("cases") if isinstance(doc, dict) else None
    cases = cases if isinstance(cases, list) else []  # 모양이 틀린 파일도 요약을 찍는다(문제는 위 목록이 말한다)
    n_cases = len(cases)
    n_steps = sum(len(c["steps"]) for c in cases if isinstance(c, dict) and isinstance(c.get("steps"), list))
    print(
        f"{'FAIL' if problems else 'ok  '} log suppression vectors (v{doc.get('version') if isinstance(doc, dict) else '?'}): "
        f"{n_cases} cases, {n_steps} steps, {len(problems)} problems — entries + suppressed = occurrences after close"
    )
    for p in problems[:5]:
        print("     ", p[:160])
    return int(bool(problems))


CUT_RE = re.compile(r"(.*)…\(잘림 (\d+)자\)", flags=re.S)


def check_log_cut_marker(log_v: Draft202012Validator) -> int:
    """계약 v5 §C1: 가림 상한(LOG_LIMIT)보다 긴 메시지 · 예외 메시지 · 스택도 '…(잘림 N자)' 의 N 이 정확한지(남긴 글자 + N = 가린 원문 전체).
    main 처럼 표준 출력 핸들러의 MaskFilter 가 먼저 레코드를 가리고 LOG_LIMIT 에서 자르는 경로로 본다."""
    cap = _CaptureRedis()
    sink = LogSink("collector", cap)
    out = logging.StreamHandler(io.StringIO())
    install_log_masking(out, sink)
    lg = logging.getLogger("contract.logs.cut")
    lg.handlers[:], lg.propagate = [out, sink], False
    lg.setLevel(logging.DEBUG)
    big = LOG_LIMIT + 50_000
    try:
        raise RuntimeError("e" * big)
    except RuntimeError as e:
        stack_len = len(logging.Formatter().formatException((RuntimeError, e, e.__traceback__)))
        lg.error("m" * big, exc_info=e)
    asyncio.run(sink.send_pending())
    lg.handlers.clear()
    ev = json.loads(cap.entries[0]["e"])
    exc = ev.get("exception") or {}
    fields = [
        ("message", ev.get("message"), big),
        ("exception.message", exc.get("message"), big),
        ("stack", exc.get("stack"), stack_len),
    ]
    exact = 0
    for _name, text, whole in fields:
        m = CUT_RE.fullmatch(text or "")
        exact += bool(m and len(m.group(1)) + int(m.group(2)) == whole)
    errs = list(log_v.iter_errors(ev))
    bad = exact != len(fields) or bool(errs) or len(cap.entries) != 1
    print(
        f"{'FAIL' if bad else 'ok  '} log cut marker beyond LOG_LIMIT ({LOG_LIMIT} chars): kept + N == whole masked length "
        f"{exact}/{len(fields)} (message · exception.message · stack), {len(errs)} schema errors"
    )
    return int(bad)


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

    # 구역 둘(계약 v4 §D 운영 권장값): 구역 1 이 fixture 를 받고, 구역 2 는 끊겼다가 다시 받는다 → 구역 2 의 scope 가 붙은 공백
    ops = parse_shards("-90,-180,90,0|-90,45,90,180")
    scopes = [format_bboxes(x) for x in ops]

    async def run() -> tuple[list[dict[str, str]], Worker, dict[str, str], list[dict[str, str]]]:
        cap = _CaptureRedis()
        q, book, shards = RawQueue(), ShipBook("aisstream"), ShardSet("aisstream")
        a, b = (shards.add(sc) for sc in scopes)
        w = Worker(q, book)
        sink = AisSink(cap, book=book, shards=shards, worker=w, queue=q, provider="aisstream", raw_ref="-")  # type: ignore[arg-type]
        now = datetime.now(UTC).timestamp()
        for sh, sc in ((a, scopes[0]), (b, scopes[1])):
            sh.feed.on_subscribed(sc, deflate=True)
        for d in lines:
            d = {**d, "MetaData": {**d["MetaData"], "time_utc": go_time(now + d.get("_recv_offset_s", 0) - 90)}}
            w.handle(json.dumps(d).encode(), a.id)
            a.feed.on_message(now)
        b.feed.on_message(now - 60)
        b.feed.on_disconnected("server closed (1006)")
        b.feed.on_subscribed(scopes[1], deflate=True)
        b.feed.on_message(now)
        await sink.flush()
        await sink.publish_gaps()
        status = sink.status_fields()
        # fixture 재생(구역 하나, 구독 영역 없음): 공백에 scope 가 없다
        fcap, fshards, fbook, fq = _CaptureRedis(), ShardSet("fixture"), ShipBook("fixture"), RawQueue()
        fx = fshards.add(None)
        fsink = AisSink(
            fcap, book=fbook, shards=fshards, worker=Worker(fq, fbook), queue=fq, provider="fixture", raw_ref="fixture"
        )  # type: ignore[arg-type]
        fx.feed.on_subscribed("fixture:ais_east_asia_90s.jsonl", deflate=None, state="replaying")
        fx.feed.on_message(now - 30)
        fx.feed.on_disconnected("ais process restart")
        fx.feed.on_message(now)
        await fsink.publish_gaps()
        return cap.entries, w, status, fcap.entries

    entries, w, status, fixture_entries = asyncio.run(run())
    rejected = {
        k: v
        for k, v in w.counts.items()
        if k in ("json", "shape", "type", "invalid_flag", "mmsi", "time", "position_range", "part")
    }
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
    # 구역(계약 v4 §D · G D-1): 공백 scope = 그 구역의 정규화한 상자 문자열(수집기는 늘 구역 하나의 문법 SCOPE_RE 로 만든다),
    # fixture 공백은 scope 없음. 스키마는 문자열·null · 1,024자까지만 본다(형식은 api 가 검사 — 틀려도 공백은 버리지 않는다)
    gaps = [_decode(f) for f in entries if f["kind"] == "ais_gap"]
    fx_gaps = [_decode(f) for f in fixture_entries]
    fx_errs = [e for g in fx_gaps for e in gap_v.iter_errors(g)]
    base = {"started_at": "2026-09-28T00:00:00.000Z", "ended_at": "2026-09-28T00:01:00.000Z", "reason": "r"}
    bad_scopes: list[object] = ["x" * 1025, 5, ["1,1,2,2"], {"scope": "1,1,2,2"}]
    ok_scopes: list[object] = [None, "", "|".join(scopes), "fixture:ais_east_asia_90s.jsonl", "x" * 1024]
    accepted = [sc for sc in bad_scopes if not list(gap_v.iter_errors({**base, "scope": sc}))]
    rejected = [sc for sc in ok_scopes if list(gap_v.iter_errors({**base, "scope": sc}))]
    off_grammar = [g.get("scope") for g in gaps if not SCOPE_RE.fullmatch(g.get("scope") or "")]
    scope_bad = (
        [g.get("scope") for g in gaps] != [scopes[1]]
        or off_grammar
        or [("scope" in g) for g in fx_gaps] != [False]
        or fx_errs
        or accepted
        or rejected
    )
    print(
        f"{'FAIL' if scope_bad else 'ok  '} ais_gap scope: shard gaps {[g.get('scope') for g in gaps]} (off one-shard grammar "
        f"{len(off_grammar)}), fixture gaps unscoped {[('scope' not in g) for g in fx_gaps]}, schema accepted bad {len(accepted)} "
        f"· rejected valid {len(rejected)}"
    )
    failures += bool(scope_bad)
    # 상태 해시 shards(≤ 3, 계약 필드 그대로)와 합계의 의미
    try:
        view = json.loads(status["shards"])
    except (KeyError, ValueError):
        view = None
    bad_status = []
    if not isinstance(view, list) or not 1 <= len(view) <= 3 or any(tuple(v) != SHARD_FIELDS for v in view):
        bad_status.append(f"shards != list of {SHARD_FIELDS}")
    else:
        if [v["scope"] for v in view] != scopes:
            bad_status.append("shards[].scope")
        rates = [v["msgs_per_s"] for v in view if v["msgs_per_s"] is not None]
        if not rates or abs(float(status["msgs_per_s"]) - sum(rates)) > 0.02:
            bad_status.append("msgs_per_s != sum")
        lags = [v["lag_p50_s"] for v in view if v["lag_p50_s"] is not None]
        if not lags or abs(float(status["lag_p50_s"]) - max(lags)) > 0.05:
            bad_status.append("lag_p50_s != max")
        if status["connected"] != ("1" if all(v["connected"] for v in view) else "0"):
            bad_status.append("connected != all")
        if status["last_msg_at"] != max(v["last_msg_at"] for v in view if v["last_msg_at"]):
            bad_status.append("last_msg_at != max")
        if status["bbox"] != "|".join(scopes):
            bad_status.append("bbox")
    print(
        f"{'FAIL' if bad_status else 'ok  '} ais status shards/aggregates"
        + (f": {bad_status}" if bad_status else f": {len(view or [])} shards")
    )
    failures += bool(bad_status)
    # 정직성: '값 없음' 표기가 null 로 바뀌었다(fixture 의 heading 511 · cog 360 · rot -128 · ETA/IMO/선종/흘수 0)
    ships = [s for f in entries if f["kind"] == "ships" for s in _decode(f)["ships"]]  # type: ignore[index]
    statics = [s for f in entries if f["kind"] == "ships" for s in _decode(f)["static"]]  # type: ignore[index]
    nulls = {k: sum(1 for s in ships if s[k] is None) for k in ("heading_deg", "cog_deg", "rot")}
    snulls = {k: sum(1 for s in statics if s[k] is None) for k in ("imo", "ship_type", "draught_m", "eta_month")}
    sentinel = [s["mmsi"] for s in ships if s["heading_deg"] == 511 or (s["cog_deg"] or 0) >= 360 or s["rot"] == -128]
    print(
        f"{'FAIL' if sentinel else 'ok  '} ais sentinel honesty: nulls {nulls} · static nulls {snulls}, {len(sentinel)} sentinel values leaked"
    )
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
    print(
        f"{'FAIL' if wrong or gnss else 'ok  '} ais position_source honesty: {ts60} Timestamp-60 reports → null, {len(wrong)} mismatches, {gnss} 'gnss' published"
    )
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
    if set(st["properties"]["msg_type"]["enum"]) != set(POSITION_CLASS) or set(st["properties"]["class"]["enum"]) != set(
        POSITION_CLASS.values()
    ):
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


WS_SCHEMAS = SCHEMAS / "ws"
WS_SAMPLES = ROOT / "apps" / "web" / "tests" / "fixtures" / "ws-samples.v1.json"
# RFC 3339 날짜-시간(시간대 필수). 이 환경의 FormatChecker 는 date-time 을 보지 않는다(rfc3339 검사기 없음) — WS 검사에만 직접 건다
RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


def _ws_format_checker() -> FormatChecker:
    fc = FormatChecker()

    @fc.checks("date-time", raises=ValueError)
    def _date_time(v: object) -> bool:
        if not isinstance(v, str):
            return True
        if not RFC3339.match(v):
            return False
        datetime.fromisoformat(v.replace("Z", "+00:00"))  # 달력에 없는 날짜는 ValueError
        return True

    return fc


def check_ws_samples() -> int:
    """계약 v5 §E1: schemas/ws/server.v1.json · client.v1.json 이 올바른 2020-12 스키마이고, 커밋된 웹 fixture(api WsSchemaContractTest 가
    실제 빌더로 만든 표본)의 모든 메시지가 그 스키마를 만족하며, 서버 17종 · 클라이언트 10종을 모두 담고, ships_grid 칸의 선종별 수 합 = 칸 수인지.
    fixture 가 없거나 낡았으면: cd apps/api && ./gradlew test --tests 'dev.wakeline.ws.WsSchemaContractTest' -PupdateWsSamples"""
    failures = 0
    samples = json.loads(WS_SAMPLES.read_text())
    fc = _ws_format_checker()
    for part, file in (("server", "server.v1.json"), ("client", "client.v1.json")):
        doc = json.loads((WS_SCHEMAS / file).read_text())
        Draft202012Validator.check_schema(doc)
        v = Draft202012Validator(doc, format_checker=fc)
        rows = samples.get(part) or []
        bad = [
            f"{r['name']}: {next(iter(v.iter_errors(r['message']))).message[:160]}" for r in rows if not v.is_valid(r["message"])
        ]
        want = set(doc["properties"]["type"]["enum"])
        have = {r["message"].get("type") for r in rows}
        missing = sorted(want - have)
        print(
            f"{'FAIL' if bad or missing else 'ok  '} ws {part} samples: {len(rows)} messages, {len(have & want)}/{len(want)} types"
            + (f" — invalid: {bad}" if bad else "")
            + (f" — missing types: {missing}" if missing else "")
        )
        failures += bool(bad) or bool(missing)
        # 가짜 date-time 은 거절해야 한다(검사기가 실제로 걸려 있는지)
        if part == "server":
            probe = next(r["message"] for r in rows if r["message"].get("type") == "welcome")
            if v.is_valid({**probe, "server_time": "2026-02-30T00:00:00Z"}) or v.is_valid({**probe, "server_time": "yesterday"}):
                print("FAIL ws date-time format is not enforced")
                failures += 1
    grid_bad = [
        c
        for r in samples.get("server", [])
        if r["message"].get("type") == "ships_grid"
        for c in r["message"]["cells"]
        if sum(c[4]) != c[2]
    ]
    print(
        f"{'FAIL' if grid_bad else 'ok  '} ws ships_grid per-category counts sum to the cell count"
        + (f": {grid_bad[:3]}" if grid_bad else "")
    )
    failures += bool(grid_bad)
    return failures


if __name__ == "__main__":
    sys.exit(main())
