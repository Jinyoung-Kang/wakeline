#!/usr/bin/env python3
"""QA 기능 퍼저(QA 2026-10 §3.2) — 공개 · 운영 GET 경로마다 정상 · 경계 · 비정상 입력 표를 돌려 상태 · RFC 9457 모양 · 지연 · 크기를 기록한다.

표준 라이브러리만. 운영 경로는 tools/qa/qa_session.py 의 OpsSession(시험 계정 qa-b)으로 부른다. 격리 스택(8701 · 8702)만 — 다른 포트는 거절한다.
요청 제한(/api/** IP당 분당 120 — 다른 QA 에이전트와 같은 IP 를 나눠 쓴다)을 지키려고 X-RateLimit-Remaining 이 RESERVE 아래로 내려가면 창이
새로 열릴 때까지 쉰다. 429 를 받으면 Retry-After 만큼 쉬고 한 번 더 보낸다.

    python3 tools/qa/fuzz_api.py                         # 공개 + 운영 전체 → docs/qa/2026-10/evidence/functional/fuzz-<UTC>.jsonl · .md
    python3 tools/qa/fuzz_api.py --only 'stats|replay'   # 경로 이름 정규식으로 좁히기
    python3 tools/qa/fuzz_api.py --no-ops                # 공개만

판정(사례마다): expect = ok(2xx · 304) | bad(4xx) | any(5xx 만 아니면). 표시(flags):
  5xx · accepted_invalid(bad 인데 2xx) · rejected_valid(ok 인데 4xx) · problem_shape(오류 본문이 RFC 9457 + code · request_id 가 아님) ·
  rid_mismatch(본문 request_id ≠ X-Request-Id) · slow(> SLOW_MS) · edge(nginx 가 답함 — api 에 닿지 않음).
같은 값 종류(param_kind, value)를 쓰는 경로끼리 상태가 다르면 '경로 사이 불일치' 로 요약에 적는다.
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.client
import json
import os
import re
import sys
import time
from urllib.parse import quote, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ALLOWED_PORTS = {8701, 8702}
RESERVE = 45          # 다른 에이전트 몫으로 남겨 둘 분당 요청 수
SLOW_MS = 1500
EDGE_URI_MAX = 8000   # nginx large_client_header_buffers 8k — 넘으면 edge 414
PROBLEM_KEYS = ("type", "title", "status", "detail", "code", "request_id")
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_DIR = os.path.join(REPO, "docs", "qa", "2026-10", "evidence", "functional")


# ------------------------------------------------------------------ 전송

class Client:
    """http.client 로 경로를 그대로(이미 인코딩한 글자) 보낸다 — urllib 처럼 다시 고치거나 거절하지 않는다."""

    def __init__(self, base: str, ops=None):
        u = urlparse(base)
        if u.port not in ALLOWED_PORTS:
            raise SystemExit(f"QA 는 격리 스택만: {base}")
        self.host, self.port = u.hostname, u.port
        self.ops = ops  # OpsSession(쿠키 · CSRF) — 운영 경로만
        self.remaining = 120
        self.reset_s = 60
        self.sent = 0

    def _throttle(self):
        if self.remaining < RESERVE:
            wait = max(1, self.reset_s) + 1
            print(f"  … 요청 제한 남은 수 {self.remaining} < {RESERVE} — {wait}s 쉼", file=sys.stderr)
            time.sleep(wait)
            self.remaining = 120
        time.sleep(0.25)  # edge 10 r/s 양동이를 다른 에이전트와 나눠 쓴다

    def send(self, method: str, path: str, headers: dict | None = None, body: bytes | None = None, use_ops: bool = False):
        for attempt in range(2):
            self._throttle()
            h = {"Accept": "application/json, application/geo+json, application/problem+json", "User-Agent": "wakeline-qa-fuzz/1"}
            if use_ops and self.ops is not None:
                cookie = "; ".join(f"{c.name}={c.value}" for c in self.ops.jar)
                if cookie:
                    h["Cookie"] = cookie
                if method not in ("GET", "HEAD", "OPTIONS"):
                    h["Origin"] = self.ops.origin
                    h["Sec-Fetch-Site"] = "same-origin"
                    tok = self.ops.csrf()
                    if tok:
                        h["X-CSRF-Token"] = tok
            h.update(headers or {})
            conn = http.client.HTTPConnection(self.host, self.port, timeout=30)
            t0 = time.perf_counter()
            try:
                conn.putrequest(method, path, skip_accept_encoding=True)
                for k, v in h.items():
                    conn.putheader(k, v)
                if body is not None:
                    conn.putheader("Content-Length", str(len(body)))
                conn.endheaders(body)
                r = conn.getresponse()
                data = r.read()
                ms = (time.perf_counter() - t0) * 1000
                hdrs = {k.lower(): v for k, v in r.getheaders()}
                status = r.status
            except Exception as e:  # 연결 끊김 등 — 그 자체가 결과
                return {"status": -1, "error": repr(e), "ms": (time.perf_counter() - t0) * 1000, "headers": {}, "body": b""}
            finally:
                conn.close()
            self.sent += 1
            if "x-ratelimit-remaining" in hdrs:
                try:
                    self.remaining = int(hdrs["x-ratelimit-remaining"])
                    self.reset_s = int(hdrs.get("x-ratelimit-reset", "60"))
                except ValueError:
                    pass
            if status == 429 and attempt == 0:
                ra = int(hdrs.get("retry-after", "10") or 10) if hdrs.get("retry-after", "").isdigit() else 10
                print(f"  … 429 ({path[:60]}) — {ra + 1}s 쉬고 다시", file=sys.stderr)
                time.sleep(ra + 1)
                self.remaining = 120
                continue
            return {"status": status, "ms": ms, "headers": hdrs, "body": data}
        return {"status": 429, "ms": 0, "headers": {}, "body": b""}


# ------------------------------------------------------------------ 값 표

def enc(v: str) -> str:
    return quote(v, safe=",:")


def iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


NOW = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
KST = dt.timezone(dt.timedelta(hours=9))

# 시각(Instant) 값: (이름, 글자, 기대). 기대는 '혼자 보냈을 때'(짝 파라미터 없음) — 경로가 범위를 따로 검사하므로 미래 · 아주 옛날은 any.
INSTANTS = [
    ("valid_recent", iso(NOW - dt.timedelta(hours=1)), "ok"),
    ("offset_kst", (NOW - dt.timedelta(hours=1)).astimezone(KST).isoformat(), "ok"),
    ("nanos", (NOW - dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S") + ".123456789Z", "ok"),
    ("lowercase_z", iso(NOW - dt.timedelta(hours=1)).replace("T", "t").replace("Z", "z"), "any"),
    ("no_zone", (NOW - dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S"), "bad"),
    ("date_only", (NOW - dt.timedelta(days=1)).strftime("%Y-%m-%d"), "bad"),
    ("epoch_ms", str(int((NOW - dt.timedelta(hours=1)).timestamp() * 1000)), "any"),
    ("epoch_s", str(int((NOW - dt.timedelta(hours=1)).timestamp())), "any"),
    ("exponent", "1.7e12", "bad"),
    ("zero", "0", "any"),
    ("negative", "-1", "any"),
    ("nan", "NaN", "bad"),
    ("infinity", "Infinity", "bad"),
    ("huge_2p63", "9223372036854775808", "bad"),
    ("huge_1e308", "1e308", "bad"),
    ("empty", "", "any"),
    ("garbage", "yesterday", "bad"),
    ("year_300000", "+300000-01-01T00:00:00Z", "bad"),
    ("year_neg_5000", "-5000-01-01T00:00:00Z", "bad"),
    ("year_max", "+1000000000-12-31T23:59:59Z", "bad"),
    ("year_min", "-1000000000-01-01T00:00:00Z", "bad"),
    ("year_10000", "+10000-01-01T00:00:00Z", "bad"),
    ("epoch_1970", "1970-01-01T00:00:00Z", "any"),
    ("leap_second", "2026-09-30T23:59:60Z", "any"),
    ("feb_30", "2026-02-30T00:00:00Z", "bad"),
    ("hour_25", "2026-09-30T25:00:00Z", "bad"),
    ("future_1y", iso(NOW + dt.timedelta(days=365)), "any"),
    ("quote", iso(NOW - dt.timedelta(hours=1)) + "'", "bad"),
    ("nul", iso(NOW - dt.timedelta(hours=1)) + "\x00", "bad"),
    ("fullwidth_digits", "２０２６-10-01T00:00:00Z", "bad"),
    ("rtl_mark", "‮" + iso(NOW - dt.timedelta(hours=1)), "bad"),
    ("long_6000", "2" * 6000, "bad"),
    ("long_10000", "2" * 10000, "bad"),
]

# 날짜(LocalDate) 값
_today_kst = NOW.astimezone(KST).date()
DATES = [
    ("valid_yesterday", (_today_kst - dt.timedelta(days=1)).isoformat(), "ok"),
    ("valid_today", _today_kst.isoformat(), "ok"),
    ("instant_form", iso(NOW), "bad"),
    ("compact", _today_kst.strftime("%Y%m%d"), "bad"),
    ("slashes", _today_kst.strftime("%Y/%m/%d"), "bad"),
    ("us_short", _today_kst.strftime("%m/%d/%y"), "bad"),
    ("feb_30", "2026-02-30", "bad"),
    ("month_13", "2026-13-01", "bad"),
    ("leap_2028", "2028-02-29", "any"),
    ("year_0", "0000-01-01", "any"),
    ("year_neg", "-0001-01-01", "any"),
    ("year_10000", "+10000-01-01", "any"),
    ("year_300000", "+300000-01-01", "any"),
    ("year_6000000", "+6000000-01-01", "any"),
    ("year_max", "+999999999-12-31", "any"),
    ("year_min", "-999999999-01-01", "any"),
    ("empty", "", "any"),
    ("nan", "NaN", "bad"),
    ("number", "20261001", "bad"),
    ("exponent", "2e7", "bad"),
    ("fullwidth", "２０２６-10-01", "bad"),
    ("quote", _today_kst.isoformat() + "'", "bad"),
    ("nul", _today_kst.isoformat() + "\x00", "bad"),
    ("long_6000", "1" * 6000, "bad"),
]

# 정수(limit 등)
INTS = [
    ("one", "1", "ok"), ("zero", "0", "any"), ("negative", "-1", "any"), ("int_max", "2147483647", "any"),
    ("int_overflow", "2147483648", "bad"), ("long_overflow", "9223372036854775808", "bad"), ("huge_1e308", "1e308", "bad"),
    ("huge_1e400", "1e400", "bad"), ("exponent", "1e1", "bad"), ("decimal", "10.5", "bad"), ("nan", "NaN", "bad"),
    ("infinity", "Infinity", "bad"), ("hex", "0x10", "bad"), ("plus", "+5", "any"), ("spaces", " 5 ", "any"),
    ("empty", "", "any"), ("garbage", "ten", "bad"), ("fullwidth", "５", "bad"), ("nul", "5\x00", "bad"), ("long_6000", "9" * 6000, "bad"),
]

# Long cursor
CURSORS = [
    ("valid", "9007199254740991", "ok"), ("zero", "0", "any"), ("negative", "-5", "any"), ("long_max", "9223372036854775807", "any"),
    ("long_overflow", "9223372036854775808", "bad"), ("decimal", "1.5", "bad"), ("exponent", "1e3", "bad"), ("garbage", "abc", "bad"),
    ("empty", "", "any"), ("nan", "NaN", "bad"),
]

# bbox 문자열(lomin,lamin,lomax,lamax)
BBOXES = [
    ("korea", "124,33,132,39", "ok"),
    ("decimals", "124.5,33.25,131.75,38.875", "ok"),
    ("spaces", " 124 , 33 , 132 , 39 ", "ok"),
    ("signs", "+124,+33,+132,+39", "ok"),
    ("area_limit_exact", "0,0,50,50", "ok"),
    ("area_over_limit", "0,0,50,50.1", "bad"),
    ("world", "-180,-90,180,90", "bad"),
    ("antimeridian", "170,-10,-170,10", "bad"),
    ("inverted_lon", "132,33,124,39", "bad"),
    ("inverted_lat", "124,39,132,33", "bad"),
    ("zero_width", "124,33,124,39", "bad"),
    ("lon_181", "124,33,181,39", "bad"),
    ("lat_91", "124,33,132,91", "bad"),
    ("lat_neg_91", "124,-91,132,39", "bad"),
    ("nan", "NaN,33,132,39", "bad"),
    ("infinity", "-Infinity,33,132,39", "bad"),
    ("exponent", "1.24e2,33,132,39", "bad"),
    ("hex_float", "0x7Cp0,33,132,39", "bad"),
    ("suffix_d", "124d,33,132,39", "bad"),
    ("huge_1e308", "124,33,1e308,39", "bad"),
    ("huge_2p63", "124,33,9223372036854775808,39", "bad"),
    ("digits_21", "124,33,132.000000000000000000001,39", "bad"),
    ("three", "124,33,132", "bad"),
    ("five", "124,33,132,39,1", "bad"),
    ("trailing_comma", "124,33,132,39,", "bad"),
    ("empty", "", "bad"),
    ("commas", ",,,", "bad"),
    ("semicolons", "124;33;132;39", "bad"),
    ("fullwidth_digit", "１２４,33,132,39", "bad"),
    ("arabic_digit", "١٢٤,33,132,39", "bad"),
    ("quote", "124',33,132,39", "bad"),
    ("nul", "124\x00,33,132,39", "bad"),
    ("rtl", "‮124,33,132,39", "bad"),
    ("long_6000", "1" * 6000 + ",33,132,39", "bad"),
    ("neg_zero", "-0,-0,10,10", "ok"),
    ("tiny", "124,33,124.000001,33.000001", "ok"),
]

STRINGS = [  # 자유 글자(검색어 등) — 기대는 경로마다 덮어쓴다
    ("quote", "AB'C"), ("dquote", 'AB"C'), ("backslash", "AB\\C"), ("percent", "AB%C"), ("nul", "AB\x00C"), ("lead_nul", "\x00AB"),
    ("unicode", "가나다"), ("emoji", "AB😀"), ("rtl", "‮ABC"), ("zero_width", "AB​C"), ("sql", "' OR 1=1--"),
    ("regex", "AB.*"), ("star", "*"), ("space", "   "), ("empty", ""), ("long_200", "A" * 200), ("long_6000", "A" * 6000),
    ("long_10000", "A" * 10000), ("newline", "AB\nC"), ("plus", "A+B"), ("slash", "AB/C"), ("dash", "-AB-"),
]


# ------------------------------------------------------------------ 사례 만들기

def case(route, path, query=None, expect="ok", kind="", value="", note="", ops=False, raw_query=None):
    """query = [(name, value)] — 같은 이름을 되풀이할 수 있다(중복 파라미터)."""
    q = raw_query
    if q is None and query is not None:
        q = "&".join(f"{enc(k)}={enc(v)}" for k, v in query)
    full = path + ("?" + q if q else "")
    return {"route": route, "path": full, "expect": expect, "kind": kind, "value": value, "note": note, "ops": ops}


def instant_cases(route, path, params, extra=None, ops=False, base_query=None):
    """시각 파라미터 하나씩 값 표를 넣고, 쌍(from/to · since/until)이 있으면 역순 · 같음 · 중복을 더한다."""
    out = []
    bq = list(base_query or [])
    for p in params:
        for name, v, exp in INSTANTS:
            e = exp
            if name in ("long_10000",):
                e = "bad"
            out.append(case(route, path, bq + [(p, v)], e, "instant", name, f"{p}={name}", ops))
        out.append(case(route, path, bq + [(p, iso(NOW - dt.timedelta(hours=2))), (p, iso(NOW - dt.timedelta(hours=1)))], "bad", "instant", "duplicate", f"{p} twice", ops))
    if len(params) == 2:
        a, b = params
        t1, t2 = NOW - dt.timedelta(hours=3), NOW - dt.timedelta(hours=1)
        out.append(case(route, path, bq + [(a, iso(t1)), (b, iso(t2))], "ok", "range", "normal", "", ops))
        out.append(case(route, path, bq + [(a, iso(t2)), (b, iso(t1))], "bad", "range", "reversed", "", ops))
        out.append(case(route, path, bq + [(a, iso(t1)), (b, iso(t1))], "any", "range", "equal", "", ops))
        for name, (fa, fb, exp) in (extra or {}).items():
            out.append(case(route, path, bq + [(a, fa), (b, fb)], exp, "range", name, "", ops))
    return out


def bbox_cases(route, path, param="bbox", base=None, area_limited=True, ops=False):
    out = []
    for name, v, exp in BBOXES:
        e = exp
        if not area_limited and name in ("area_over_limit", "world"):
            e = "ok"
        if name == "area_limit_exact":
            e = "ok"
        out.append(case(route, path, list(base or []) + [(param, v)], e, "bbox", name, "", ops))
    out.append(case(route, path, list(base or []) + [(param, "124,33,132,39"), (param, "125,34,131,38")], "bad", "bbox", "duplicate", "bbox twice", ops))
    out.append(case(route, path, list(base or []) + [(param, "1" * 10000)], "bad", "bbox", "long_10000", "edge 414 예상", ops))
    return out


def int_cases(route, path, param, base=None, ops=False, valid="ok"):
    out = []
    for name, v, exp in INTS:
        out.append(case(route, path, list(base or []) + [(param, v)], exp if name != "one" else valid, "int:" + param, name, "", ops))
    out.append(case(route, path, list(base or []) + [(param, "5"), (param, "6")], "any", "int:" + param, "duplicate", "", ops))
    return out


def cursor_cases(route, path, param="cursor", base=None, ops=False):
    return [case(route, path, list(base or []) + [(param, v)], exp, "cursor", name, "", ops) for name, v, exp in CURSORS]


def path_cases(route, template, values, ops=False):
    return [case(route, template.format(enc_path(v)), None, exp, "path:" + route, name, "", ops) for name, v, exp in values]


def enc_path(v: str) -> str:
    return quote(v, safe=":")


def date_cases(route, path, params, base=None, ops=False):
    out = []
    for p in params:
        for name, v, exp in DATES:
            out.append(case(route, path, list(base or []) + [(p, v)], exp, "date", name, f"{p}={name}", ops))
        out.append(case(route, path, list(base or []) + [(p, "2026-09-01"), (p, "2026-09-02")], "bad", "date", "duplicate", f"{p} twice", ops))
    if len(params) == 2:
        a, b = params
        y = _today_kst - dt.timedelta(days=1)
        out += [
            case(route, path, [(a, (y - dt.timedelta(days=6)).isoformat()), (b, y.isoformat())], "ok", "date_range", "week", "", ops),
            case(route, path, [(a, y.isoformat()), (b, (y - dt.timedelta(days=6)).isoformat())], "bad", "date_range", "reversed", "", ops),
            case(route, path, [(a, (y - dt.timedelta(days=92)).isoformat()), (b, y.isoformat())], "ok", "date_range", "exactly_92d", "", ops),
            case(route, path, [(a, (y - dt.timedelta(days=93)).isoformat()), (b, y.isoformat())], "bad", "date_range", "93d", "", ops),
            case(route, path, [(a, "+999999999-12-31"), (b, "+999999999-12-31")], "bad", "date_range", "max_max", "LocalDate.MAX 쌍", ops),
            case(route, path, [(b, "-999999999-01-01")], "bad", "date_range", "to_min_only", "to=LocalDate.MIN, from 기본(to−7)", ops),
            case(route, path, [(a, "+300000-01-01"), (b, "+300000-01-02")], "bad", "date_range", "y300000_pair", "PostgreSQL timestamp 범위 밖", ops),
            case(route, path, [(a, "+10000-01-01"), (b, "+10000-01-02")], "any", "date_range", "y10000_pair", "", ops),
        ]
    return out


def string_cases(route, path, param, expect_map, base=None, ops=False):
    out = []
    for name, v in STRINGS:
        exp = expect_map.get(name, expect_map.get("*", "any"))
        if name == "long_10000":
            exp = "bad"
        out.append(case(route, path, list(base or []) + [(param, v)], exp, "str:" + param, name, "", ops))
    return out


HEXES = [("valid", "71be01", "any"), ("upper", "71BE01", "any"), ("spaces", " 71be01 ", "any"), ("short", "71be0", "bad"), ("long", "71be012", "bad"),
         ("non_hex", "71be0g", "bad"), ("tilde", "~71be0", "bad"), ("nul", "71be01\x00", "bad"), ("dotdot", "..", "bad"), ("unicode", "７１be01", "bad"),
         ("long_6000", "a" * 6000, "bad"), ("negative", "-1", "bad"), ("exponent", "1e5", "bad"), ("sql", "' or 1", "bad")]
MMSIS = [("valid", "440123450", "any"), ("short", "44012345", "bad"), ("long", "4401234500", "bad"), ("letters", "44012345a", "bad"),
         ("spaces", " 440123450 ", "any"), ("negative", "-44012345", "bad"), ("exponent", "4.4e8", "bad"), ("unicode", "４40123450", "bad"),
         ("arabic", "٤٤٠١٢٣٤٥٠", "bad"), ("nul", "440123450\x00", "bad"), ("long_6000", "4" * 6000, "bad"), ("zero", "000000000", "any")]


def build_public(only: re.Pattern | None):
    A = "/api/v1"
    yday = NOW - dt.timedelta(days=1)
    C = []
    C += [case("healthz", "/healthz")]
    C += [case("status", A + "/status"), case("status", A + "/status", [("x", "1")], "ok", "extra", "unknown_param")]
    # aircraft
    C += bbox_cases("aircraft", A + "/aircraft")
    C += [case("aircraft", A + "/aircraft", [("bbox", "124,33,132,39"), ("detail", d)], e, "enum:detail", d) for d, e in
          (("full", "ok"), ("lite", "ok"), ("FULL", "any"), ("bogus", "any"), ("", "any"))]
    C += [case("aircraft", A + "/aircraft", None, "bad", "missing", "bbox")]
    C += string_cases("aircraft.search", A + "/aircraft/search", "q", {"*": "bad", "dash": "any", "lead_nul": "any", "space": "bad", "plus": "bad"})
    C += [case("aircraft.search", A + "/aircraft/search", [("q", v)], e, "q", n) for n, v, e in
          (("prefix", "71", "ok"), ("callsign", "KAL", "ok"), ("one_char", "7", "bad"), ("ten", "ABCDEFGHIJ", "ok"), ("eleven", "ABCDEFGHIJK", "bad"),
           ("lower", "kal", "ok"), ("dup", None, "any"))
          if v is not None]
    C += [case("aircraft.search", A + "/aircraft/search", [("q", "KAL"), ("q", "AAR")], "any", "q", "duplicate")]
    C += [case("aircraft.search", A + "/aircraft/search", None, "bad", "missing", "q")]
    C += path_cases("aircraft.detail", A + "/aircraft/{}", HEXES)
    C += path_cases("aircraft.track", A + "/aircraft/{}/track", HEXES)
    C += instant_cases("aircraft.track", A + "/aircraft/71be01/track", ["from", "to"], extra={
        "exactly_24h": (iso(yday), iso(NOW), "ok"), "24h_plus_1s": (iso(yday - dt.timedelta(seconds=1)), iso(NOW), "bad"),
        "y300000_1h": ("+300000-01-01T00:00:00Z", "+300000-01-01T01:00:00Z", "bad"),
        "y_neg_5000_1h": ("-5000-01-01T00:00:00Z", "-5000-01-01T01:00:00Z", "bad"),
        "future_1h": (iso(NOW + dt.timedelta(days=30)), iso(NOW + dt.timedelta(days=30, hours=1)), "any"),
    })
    C += int_cases("aircraft.track", A + "/aircraft/71be01/track", "stepS")
    # ships
    C += bbox_cases("ships", A + "/ships")
    C += [case("ships", A + "/ships", None, "bad", "missing", "bbox")]
    C += string_cases("ships.search", A + "/ships/search", "q", {"*": "any", "empty": "bad", "space": "bad", "long_6000": "bad", "long_200": "bad"})
    C += [case("ships.search", A + "/ships/search", [("q", v)], e, "q", n) for n, v, e in
          (("mmsi9", "432952000", "ok"), ("mmsi_prefix3", "432", "ok"), ("mmsi_prefix2", "43", "any"), ("imo", "IMO9", "any"), ("imo7", "9000000", "any"),
           ("name", "EVER", "ok"), ("one_char", "E", "any"))]
    C += [case("ships.search", A + "/ships/search", None, "bad", "missing", "q")]
    C += int_cases("ships.search", A + "/ships/search", "limit", base=[("q", "432")], valid="ok")
    C += [case("ships.search", A + "/ships/search", [("q", "432"), ("limit", v)], e, "int:limit", n) for n, v, e in
          (("limit_20", "20", "ok"), ("limit_21", "21", "bad"))]
    C += path_cases("ships.detail", A + "/ships/{}", MMSIS)
    C += path_cases("ships.track", A + "/ships/{}/track", MMSIS)
    C += instant_cases("ships.track", A + "/ships/432952000/track", ["from", "to"], extra={
        "exactly_24h": (iso(yday), iso(NOW), "ok"), "24h_plus_1s": (iso(yday - dt.timedelta(seconds=1)), iso(NOW), "bad"),
        "y300000_1h": ("+300000-01-01T00:00:00Z", "+300000-01-01T01:00:00Z", "bad"),
        "y_neg_5000_1h": ("-5000-01-01T00:00:00Z", "-5000-01-01T01:00:00Z", "bad"),
    })
    C += [case("ships.coverage", A + "/ships/coverage"), case("traffic.grid", A + "/traffic/grid")]
    C += instant_cases("ais.gaps", A + "/ais/gaps", ["from", "to"], extra={
        "exactly_31d": (iso(NOW - dt.timedelta(days=31)), iso(NOW), "ok"), "31d_plus_1s": (iso(NOW - dt.timedelta(days=31, seconds=1)), iso(NOW), "bad"),
        "y300000_1h": ("+300000-01-01T00:00:00Z", "+300000-01-01T01:00:00Z", "bad"),
    })
    # weather · airports
    C += bbox_cases("sigmets", A + "/sigmets", area_limited=False)
    C += [case("sigmets", A + "/sigmets", [("active", v)], e, "bool:active", n) for n, v, e in
          (("true", "true", "ok"), ("false", "false", "ok"), ("one", "1", "any"), ("yes", "yes", "any"), ("on", "on", "any"), ("TRUE", "TRUE", "any"),
           ("maybe", "maybe", "bad"), ("empty", "", "any"), ("two", "2", "bad"), ("dup", None, "any")) if v is not None]
    C += [case("sigmets", A + "/sigmets", [("hazard", v)], e, "enum:hazard", n) for n, v, e in
          (("turb", "TURB", "ok"), ("lower", "turb", "ok"), ("bogus", "XYZ", "any"), ("empty", "", "any"), ("long", "A" * 6000, "any"))]
    C += path_cases("sigmets.one", A + "/sigmets/{}", [("valid", "RJJJ:I01:1790873720", "any"), ("missing", "NOPE", "bad"), ("empty_seg", " ", "bad"),
                                                       ("nul", "a\x00b", "bad"), ("long_6000", "A" * 6000, "bad"), ("unicode", "가나", "bad"),
                                                       ("encoded_slash", "a/b", "bad"), ("dotdot", "..", "bad")])
    C += [case("alerts", A + "/alerts", [("kind", v)], e, "enum:kind", n) for n, v, e in
          (("none", None, "ok"), ("observed", "observed", "ok"), ("predicted", "PREDICTED", "ok"), ("bogus", "bogus", "any"), ("empty", "", "any"))
          if v is not None] + [case("alerts", A + "/alerts")]
    C += instant_cases("alerts.history", A + "/alerts/history", ["from", "to"], extra={
        "exactly_30d": (iso(NOW - dt.timedelta(days=30)), iso(NOW), "ok"), "30d_plus_1s": (iso(NOW - dt.timedelta(days=30, seconds=1)), iso(NOW), "bad"),
        "y300000_1h": ("+300000-01-01T00:00:00Z", "+300000-01-01T01:00:00Z", "bad"),
        "y_max_both": ("+1000000000-12-31T00:00:00Z", "+1000000000-12-31T01:00:00Z", "bad"),
    })
    C += int_cases("alerts.history", A + "/alerts/history", "limit")
    C += cursor_cases("alerts.history", A + "/alerts/history")
    C += [case("alerts.history", A + "/alerts/history", [("hex", h)], e, "query_hex", n) for n, h, e in HEXES if n != "long_6000"]
    C += [case("radar.frames", A + "/radar/frames"), case("radar.kr", A + "/radar/kr")]
    C += path_cases("radar.kr.png", A + "/radar/kr/{}.png", [("valid_shape", "202610010000", "any"), ("short", "2026100100", "bad"), ("month_13", "202613010000", "any"),
                                                            ("letters", "2026100100ab", "bad"), ("fullwidth", "２０２６１００１００００", "bad"),
                                                            ("arabic", "٢٠٢٦١٠٠١٠٠٠٠", "bad"), ("negative", "-20261001000", "bad"), ("long_6000", "1" * 6000, "bad")])
    C += bbox_cases("airports", A + "/airports", area_limited=False)
    C += [case("airports", A + "/airports", [("watched", v)], e, "bool:watched", n) for n, v, e in
          (("true", "true", "ok"), ("false", "false", "ok"), ("maybe", "maybe", "bad"), ("empty", "", "any"))]
    C += path_cases("airports.wx", A + "/airports/{}/wx", [("valid", "RKSI", "any"), ("lower", "rksi", "any"), ("short", "RKS", "bad"), ("long", "RKSII", "bad"),
                                                          ("digits", "1234", "any"), ("spaces", " RKSI ", "any"), ("unicode", "ＲＫＳＩ", "bad"),
                                                          ("turkish_i", "rksı", "bad"), ("nul", "RKS\x00", "bad"), ("long_6000", "R" * 6000, "bad")])
    # history · stats
    C += [case("replay", A + "/replay", [("at", v), ("bbox", "124,33,132,39")], e, "instant", n) for n, v, e in INSTANTS if n not in ("empty",)]
    C += [case("replay", A + "/replay", [("at", iso(NOW - dt.timedelta(hours=1)))], "bad", "missing", "bbox"),
          case("replay", A + "/replay", [("bbox", "124,33,132,39")], "bad", "missing", "at"),
          case("replay", A + "/replay", [("at", ""), ("bbox", "124,33,132,39")], "bad", "instant", "empty", "필수 at 이 빈 값"),
          case("replay", A + "/replay", [("at", iso(NOW - dt.timedelta(days=31) + dt.timedelta(minutes=1))), ("bbox", "124,33,132,39")], "ok", "replay_edge", "31d_minus_1m"),
          case("replay", A + "/replay", [("at", iso(NOW - dt.timedelta(days=31, minutes=1))), ("bbox", "124,33,132,39")], "bad", "replay_edge", "31d_plus_1m"),
          case("replay", A + "/replay", [("at", iso(NOW + dt.timedelta(seconds=50))), ("bbox", "124,33,132,39")], "ok", "replay_edge", "future_50s"),
          case("replay", A + "/replay", [("at", iso(NOW + dt.timedelta(seconds=300))), ("bbox", "124,33,132,39")], "bad", "replay_edge", "future_5m")]
    C += bbox_cases("replay", A + "/replay", base=[("at", iso(NOW - dt.timedelta(hours=1)))])
    C += date_cases("stats.sigmet", A + "/stats/sigmet", ["from", "to"])
    C += [case("stats.sigmet", A + "/stats/sigmet", [("group", v)], e, "enum:group", n) for n, v, e in
          (("fir", "fir", "ok"), ("hazard", "hazard", "ok"), ("HAZARD", "HAZARD", "any"), ("bogus", "bogus", "any"), ("empty", "", "any"))]
    C += date_cases("stats.alerts", A + "/stats/alerts", ["from", "to"])
    C += date_cases("stats.traffic", A + "/stats/traffic", ["day"])
    return [c for c in C if not only or only.search(c["route"])]


def build_ops(only: re.Pattern | None):
    O = "/api/v1/ops"
    C = []
    for r in ("session", "providers", "dlq", "pipeline", "settings", "resolutions", "logs/groups"):
        C.append(case("ops." + r, f"{O}/{r}", None, "ok", "plain", "", ops=True))
    C += [case("ops.runs", O + "/runs", [(k, v)], e, "str:" + k, n, ops=True) for k in ("job", "provider", "status") for n, v, e in
          (("valid", {"job": "region", "provider": "fixture", "status": "ok"}[k], "ok"), ("bogus", "bogus", "any"), ("quote", "a'b", "any"),
           ("long_6000", "x" * 6000, "any"), ("nul", "a\x00", "any"), ("empty", "", "any"))]
    C += instant_cases("ops.runs", O + "/runs", ["since"], ops=True)
    C += int_cases("ops.runs", O + "/runs", "limit", ops=True)
    C += cursor_cases("ops.runs", O + "/runs", ops=True)
    C += [case("ops.runs", O + "/runs", [("resolved", v)], e, "enum:resolved", n, ops=True) for n, v, e in
          (("hide", "hide", "ok"), ("show", "show", "ok"), ("bogus", "bogus", "bad"), ("upper", "SHOW", "any"), ("empty", "", "any"))]
    C += int_cases("ops.quality", O + "/quality", "days", ops=True)
    C += int_cases("ops.audit", O + "/audit", "limit", ops=True)
    C += cursor_cases("ops.audit", O + "/audit", ops=True)
    # logs
    C += [case("ops.logs", O + "/logs", [(k, v)], e, "logs:" + k, n, ops=True) for k, n, v, e in (
        ("service", "api", "api", "ok"), ("service", "multi", "api,collector", "ok"), ("service", "bogus", "bogus", "bad"), ("service", "upper", "API", "bad"),
        ("service", "empty", "", "ok"), ("service", "commas", ",,", "ok"),
        ("level", "error", "ERROR", "ok"), ("level", "lower", "warn", "ok"), ("level", "info", "INFO", "bad"),
        ("fp", "valid", "0123456789abcdef", "ok"), ("fp", "upper", "0123456789ABCDEF", "bad"), ("fp", "short", "0123", "bad"),
        ("rid", "valid", "0123456789abcdef", "ok"), ("rid", "short", "abc", "bad"), ("rid", "bad_chars", "abc_def_ghi", "bad"),
        ("cursor", "server", "server:1-0", "ok"), ("cursor", "client", "client:1-0", "ok"), ("cursor", "legacy", "1-0", "ok"),
        ("cursor", "bogus", "bogus", "bad"), ("cursor", "huge_id", "server:99999999999999999999-0", "any"), ("cursor", "neg", "server:-1-0", "bad"),
        ("resolved", "bogus", "bogus", "bad"), ("resolved", "show", "show", "ok"),
    )]
    C += string_cases("ops.logs", O + "/logs", "q", {"*": "ok", "long_6000": "bad", "long_10000": "bad"}, ops=True)
    C += instant_cases("ops.logs", O + "/logs", ["since", "until"], ops=True, extra={
        "y300000": ("+300000-01-01T00:00:00Z", "+300000-01-01T01:00:00Z", "any")})
    C += int_cases("ops.logs", O + "/logs", "limit", ops=True)
    C += instant_cases("ops.logs.groups", O + "/logs/groups", ["since"], ops=True)
    C += path_cases("ops.logs.one", O + "/logs/{}", [("valid_shape", "1-0", "bad"), ("huge", "99999999999999999999-0", "bad"), ("over_20", "1" * 21 + "-0", "bad"),
                                                   ("no_dash", "123", "bad"), ("letters", "a-b", "bad"), ("neg", "-1-0", "bad")], ops=True)
    C += [case("ops.logs.one", O + "/logs/1-0", [("stream", v)], e, "enum:stream", n, ops=True) for n, v, e in
          (("server", "server", "bad"), ("client", "client", "bad"), ("bogus", "bogus", "bad"), ("upper", "SERVER", "any"))]
    return [c for c in C if not only or only.search(c["route"])]


# ------------------------------------------------------------------ 판정

def judge(c, r):
    flags = []
    st = r["status"]
    h = r["headers"]
    body = r["body"] or b""
    ctype = h.get("content-type", "")
    is_edge = h.get("server", "").startswith("nginx") and "x-request-id" not in h and st >= 400
    if st == -1:
        flags.append("conn_error")
    if st >= 500:
        flags.append("5xx")
    if is_edge:
        flags.append("edge")
    if c["expect"] == "bad" and 200 <= st < 400:
        flags.append("accepted_invalid")
    if c["expect"] == "ok" and 400 <= st < 500 and st != 429:
        flags.append("rejected_valid")
    problem = None
    if st >= 400 and not is_edge and st != -1:
        try:
            problem = json.loads(body)
        except ValueError:
            problem = None
        if not ctype.startswith("application/problem+json") or not isinstance(problem, dict) or any(k not in problem for k in PROBLEM_KEYS):
            flags.append("problem_shape")
        elif problem.get("status") != st:
            flags.append("problem_status")
        elif h.get("x-request-id") and problem.get("request_id") != h.get("x-request-id"):
            flags.append("rid_mismatch")
    if r.get("ms", 0) > SLOW_MS:
        flags.append("slow")
    return flags, problem


def run(cases, client, out_path):
    rows = []
    with open(out_path, "w") as f:
        for i, c in enumerate(cases):
            if len(c["path"]) > EDGE_URI_MAX + 2000:
                pass  # 그대로 보낸다 — edge 414 를 기록한다
            r = client.send("GET", c["path"], use_ops=c["ops"])
            flags, problem = judge(c, r)
            row = {
                "route": c["route"], "kind": c["kind"], "value": c["value"], "note": c["note"], "expect": c["expect"],
                "status": r["status"], "ms": round(r.get("ms", 0), 1), "bytes": len(r["body"] or b""),
                "ctype": r["headers"].get("content-type", ""), "code": (problem or {}).get("code") if isinstance(problem, dict) else None,
                "detail": (problem or {}).get("detail") if isinstance(problem, dict) else None,
                "rid": r["headers"].get("x-request-id"), "flags": flags,
                "path": c["path"] if len(c["path"]) <= 300 else c["path"][:200] + f"…(+{len(c['path']) - 200})",
                "body_head": (r["body"] or b"")[:240].decode("utf-8", "replace") if (flags and "edge" not in flags) else None,
                "error": r.get("error"),
            }
            rows.append(row)
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
            if flags and flags != ["edge"]:
                print(f"[{i + 1}/{len(cases)}] {row['status']} {','.join(flags)} {c['route']} {c['kind']}={c['value']}", file=sys.stderr)
    return rows


def status_class(s):
    if s in (200, 304):
        return "2xx"
    if s == 404:
        return "404"
    if 400 <= s < 500:
        return str(s)
    return str(s)


def summarize(rows, md_path, started, base, commit):
    flagged = [r for r in rows if r["flags"] and r["flags"] != ["edge"]]
    by_flag = {}
    for r in flagged:
        for fl in r["flags"]:
            by_flag.setdefault(fl, []).append(r)
    # 경로 사이 불일치: 같은 (kind, value) 를 쓴 경로들의 상태 종류가 다르면
    groups = {}
    for r in rows:
        if r["kind"] in ("instant", "bbox", "cursor", "date") or r["kind"].startswith("int:"):
            k = (r["kind"].split(":")[0], r["value"])
            groups.setdefault(k, {}).setdefault(r["route"], set()).add(status_class(r["status"]))
    incons = []
    for (kind, value), per_route in sorted(groups.items()):
        classes = {frozenset(v) for v in per_route.values()}
        if len(classes) > 1:
            incons.append((kind, value, per_route))
    lines = [
        f"# 기능 퍼저 결과 — {started}",
        "",
        f"- 대상: {base} · 커밋 {commit} · 요청 {len(rows)}건 · 표시된 사례 {len(flagged)}건",
        f"- 명령: `python3 tools/qa/fuzz_api.py` (원자료: `{os.path.basename(md_path).replace('.md', '.jsonl')}`)",
        "",
        "## 표시 종류별 수",
        "",
        "| 표시 | 수 |",
        "|---|---|",
    ]
    for fl, rs in sorted(by_flag.items()):
        lines.append(f"| {fl} | {len(rs)} |")
    lines += ["", "## 5xx · 비정상 수용 · 문제 응답 모양", "", "| 경로 | 종류=값 | 기대 | 상태 | code | 표시 | 요청 |", "|---|---|---|---|---|---|---|"]
    for r in flagged:
        if set(r["flags"]) & {"5xx", "accepted_invalid", "rejected_valid", "problem_shape", "problem_status", "rid_mismatch", "conn_error"}:
            p = r["path"].replace("|", "%7C")
            lines.append(f"| {r['route']} | {r['kind']}={r['value']} | {r['expect']} | {r['status']} | {r['code'] or ''} | {','.join(r['flags'])} | `{p[:140]}` |")
    lines += ["", "## 느린 응답(> %d ms)" % SLOW_MS, ""]
    for r in by_flag.get("slow", []):
        lines.append(f"- {r['route']} {r['kind']}={r['value']} {r['ms']} ms ({r['bytes']} B)")
    lines += ["", "## 같은 값 · 다른 경로 · 다른 상태(경로 사이 불일치 후보)", ""]
    for kind, value, per_route in incons:
        parts = ", ".join(f"{rt}={'/'.join(sorted(s))}" for rt, s in sorted(per_route.items()))
        lines.append(f"- `{kind}={value}`: {parts}")
    lines += ["", "## 지연 · 크기(경로별 최댓값)", "", "| 경로 | 요청 수 | 최대 ms | 중앙 ms | 최대 바이트 |", "|---|---|---|---|---|"]
    per = {}
    for r in rows:
        per.setdefault(r["route"], []).append(r)
    for rt, rs in sorted(per.items()):
        ms = sorted(x["ms"] for x in rs)
        lines.append(f"| {rt} | {len(rs)} | {ms[-1]} | {ms[len(ms) // 2]} | {max(x['bytes'] for x in rs)} |")
    with open(md_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return flagged, incons


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8701")
    ap.add_argument("--only")
    ap.add_argument("--no-ops", action="store_true")
    ap.add_argument("--user", default="qa-b")
    ap.add_argument("--out", default=OUT_DIR)
    a = ap.parse_args()
    only = re.compile(a.only) if a.only else None
    ops = None
    if not a.no_ops:
        from qa_session import OpsSession
        ops = OpsSession(a.base, a.user)
    client = Client(a.base, ops)
    cases = build_public(only) + ([] if a.no_ops else build_ops(only))
    os.makedirs(a.out, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    jl = os.path.join(a.out, f"fuzz-{stamp}.jsonl")
    md = os.path.join(a.out, f"fuzz-{stamp}.md")
    print(f"{len(cases)} cases → {jl}", file=sys.stderr)
    rows = run(cases, client, jl)
    commit = os.popen(f"git -C {REPO} rev-parse --short HEAD").read().strip()
    flagged, incons = summarize(rows, md, stamp, a.base, commit)
    fives = [r for r in rows if "5xx" in r["flags"]]
    print(f"done: {len(rows)} requests, {len(flagged)} flagged, {len(fives)} 5xx, {len(incons)} cross-route inconsistencies → {md}")
    return 1 if fives else 0


if __name__ == "__main__":
    sys.exit(main())
