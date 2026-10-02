#!/usr/bin/env python3
"""QA WS 점검(QA 2026-10 §3.2) — /ws/v1 에 클라이언트 메시지 10종의 정상 · 형식 오류 · 형 틀림 · 범위 밖 · 큰 메시지 · 빠른 반복 · hello 전 메시지 ·
모르는 종류를 보내고, 서버가 설계대로(error 메시지 · 1002 · 1008 · 1009 · 1003 · 1007 종료) 답하는지, 받은 서버 메시지가 schemas/ws/server.v1.json 에
맞는지 본다. 연결은 한 번에 하나(IP당 WS 상한 5 를 다른 QA 에이전트와 나눠 쓴다), 끝나면 늘 닫는다.

표준 라이브러리 + (있으면) jsonschema — 없으면 스키마 검증만 건너뛴다. 격리 스택(8701 · 8702)만.

    python3 tools/qa/ws_probe.py                     # → docs/qa/2026-10/evidence/functional/ws-<UTC>.jsonl · .md, 기대와 다르면 종료 코드 1
    python3 tools/qa/ws_probe.py --only 'hello|zoom'
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import socket
import struct
import sys
import time

ALLOWED_PORTS = {8701, 8702}
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_DIR = os.path.join(REPO, "docs", "qa", "2026-10", "evidence", "functional")


class Closed(Exception):
    def __init__(self, code, reason):
        super().__init__(f"closed {code} {reason!r}")
        self.code, self.reason = code, reason


class WS:
    """RFC 6455 최소 클라이언트 — 틀린 프레임(바이너리 · 잘못된 UTF-8 · 조각)도 그대로 보낼 수 있게 직접 만든다."""

    def __init__(self, host, port, origin, path="/ws/v1", timeout=10):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\nUser-Agent: wakeline-qa-ws/1\r\n\r\n")
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        self.status_line = head.split(b"\r\n")[0].decode()
        self.handshake_status = int(self.status_line.split()[1]) if len(self.status_line.split()) > 1 else -1
        self.buf = rest
        self.closed = None

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise Closed(1006, "eof")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def frame(self, opcode, payload: bytes, fin=True, mask=True):
        b0 = (0x80 if fin else 0) | opcode
        n = len(payload)
        hdr = bytes([b0])
        mbit = 0x80 if mask else 0
        if n < 126:
            hdr += bytes([mbit | n])
        elif n < 65536:
            hdr += bytes([mbit | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([mbit | 127]) + struct.pack(">Q", n)
        if mask:
            mk = os.urandom(4)
            payload = bytes(b ^ mk[i % 4] for i, b in enumerate(payload))
            hdr += mk
        self.sock.sendall(hdr + payload)

    def send(self, text):
        self.frame(1, text.encode() if isinstance(text, str) else text)

    def recv(self, timeout=5.0):
        """다음 데이터 메시지(텍스트) — 제어 프레임은 처리한다. 닫힘이면 Closed."""
        self.sock.settimeout(timeout)
        parts, op0 = [], None
        while True:
            b0, b1 = self._read(2)
            op = b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b1 & 0x80:
                mk = self._read(4)
                data = bytes(b ^ mk[i % 4] for i, b in enumerate(self._read(n)))
            else:
                data = self._read(n)
            if op == 8:
                code = struct.unpack(">H", data[:2])[0] if len(data) >= 2 else 1005
                self.closed = (code, data[2:].decode("utf-8", "replace"))
                try:
                    self.frame(8, data[:2])
                except OSError:
                    pass
                raise Closed(*self.closed)
            if op == 9:
                self.frame(10, data)
                continue
            if op == 10:
                continue
            if op in (1, 2):
                op0 = op
            parts.append(data)
            if b0 & 0x80:
                return op0, b"".join(parts)

    def drain(self, seconds, stop=None):
        """seconds 동안 받은 메시지(JSON) 목록과 닫힘(code, reason) | None."""
        out, end = [], time.time() + seconds
        while time.time() < end:
            try:
                op, data = self.recv(max(0.05, end - time.time()))
            except socket.timeout:
                break
            except Closed as c:
                return out, (c.code, c.reason)
            except OSError as e:
                return out, (1006, repr(e))
            try:
                m = json.loads(data)
            except ValueError:
                m = {"_raw": data[:200].decode("utf-8", "replace")}
            out.append(m)
            if stop and stop(m):
                break
        return out, None

    def close(self):
        try:
            self.frame(8, struct.pack(">H", 1000))
            self.drain(0.5)
        except Exception:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


# ------------------------------------------------------------------ 스키마

def load_validator():
    try:
        import jsonschema
    except ImportError:
        return None
    with open(os.path.join(REPO, "schemas", "ws", "server.v1.json")) as f:
        schema = json.load(f)
    cls = jsonschema.validators.validator_for(schema)
    return cls(schema, format_checker=cls.FORMAT_CHECKER)


def schema_errors(v, msgs):
    if v is None:
        return []
    errs = []
    for m in msgs:
        e = sorted(v.iter_errors(m), key=lambda x: len(list(x.absolute_path)))
        if e:
            best = e[0]
            errs.append({"type": m.get("type"), "error": best.message[:300], "path": list(best.absolute_path)[:6]})
    return errs


# ------------------------------------------------------------------ 시나리오

HELLO = json.dumps({"type": "hello", "proto": 1, "client": "qa"})
KOREA = [124, 33, 132, 39]


def sub(bbox=None, zoom=7, **kw):
    m = {"type": "subscribe", "bbox": KOREA if bbox is None else bbox}
    if zoom is not None:
        m["zoom"] = zoom
    m.update(kw)
    return json.dumps(m)


def raw_sub(bbox_text, zoom_text="7"):
    return '{"type":"subscribe","bbox":' + bbox_text + ',"zoom":' + zoom_text + "}"


BIG_INT_400 = "1" + "0" * 399
# (이름, 보낼 것들[(종류, 값)], 기대) — 종류: text · frame(opcode, bytes, fin) · wait(초).
# 기대: {"close": 코드 | None(열린 채), "error": 코드 | None, "reply": 받아야 할 type | None}
SCENARIOS = [
    # 정상
    ("normal_hello_subscribe", [("text", HELLO), ("text", sub()), ("wait", 6), ("text", '{"type":"ping"}'), ("wait", 1)],
     {"close": None, "reply": "snapshot", "also": ["welcome", "pong"]}),
    ("normal_ships_layer", [("text", HELLO), ("text", sub([110, 20, 150, 45], 6)), ("text", '{"type":"layers","ships":true}'), ("wait", 4)],
     {"close": None, "reply": "ships_snapshot"}),
    ("normal_select_and_ship", [("text", HELLO), ("text", sub()), ("text", '{"type":"select","hex":"71BE01"}'),
                                ("text", '{"type":"select_ship","mmsi":"432952000"}'), ("wait", 3)], {"close": None, "reply": "selected"}),
    ("normal_resync_scopes", [("text", HELLO), ("text", sub()), ("wait", 1), ("text", '{"type":"resync","scope":"alerts"}'),
                              ("text", '{"type":"resync","scope":"sigmets"}'), ("text", '{"type":"resync","scope":"radar"}'),
                              ("text", '{"type":"resync"}'), ("text", '{"type":"resync","scope":null}'), ("wait", 3)], {"close": None, "reply": "sigmets"}),
    ("normal_pause_resume", [("text", HELLO), ("text", sub()), ("wait", 1), ("text", '{"type":"pause"}'), ("wait", 1), ("text", '{"type":"resume"}'), ("wait", 2)],
     {"close": None, "reply": "snapshot"}),
    ("fragmented_hello", [("frame", 1, b'{"type":"hel', False), ("frame", 0, b'lo","proto":1}', True), ("wait", 1)], {"close": None, "reply": "welcome"}),
    # hello 전
    ("subscribe_before_hello", [("text", sub()), ("wait", 2)], {"close": 1002, "error": "HELLO_REQUIRED"}),
    ("ping_before_hello", [("text", '{"type":"ping"}'), ("wait", 2)], {"close": 1002, "error": "HELLO_REQUIRED"}),
    ("unknown_before_hello", [("text", '{"type":"bogus"}'), ("wait", 2)], {"close": 1002, "error": "HELLO_REQUIRED"}),
    ("bad_json_before_hello", [("text", "{"), ("wait", 2)], {"close": 1002, "error": "BAD_JSON"}),
    ("hello_timeout", [("wait", 7)], {"close": 1002}),
    ("upper_hello", [("text", '{"type":"HELLO","proto":1}'), ("wait", 2)], {"close": 1002, "error": "HELLO_REQUIRED"}),
    # hello 값
    ("hello_proto_2", [("text", '{"type":"hello","proto":2}'), ("wait", 2)], {"close": 1002, "error": "UNSUPPORTED_PROTO"}),
    ("hello_proto_missing", [("text", '{"type":"hello"}'), ("wait", 2)], {"close": 1002, "error": "UNSUPPORTED_PROTO"}),
    ("hello_proto_null", [("text", '{"type":"hello","proto":null}'), ("wait", 2)], {"close": 1002, "error": "UNSUPPORTED_PROTO"}),
    ("hello_proto_string", [("text", '{"type":"hello","proto":"1"}'), ("wait", 2)], {"close": "any", "note": "스키마는 const 1 — 서버는 더 너그러울 수 있다"}),
    ("hello_proto_1_9", [("text", '{"type":"hello","proto":1.9}'), ("wait", 2)], {"close": "any"}),
    ("hello_proto_2p31", [("text", '{"type":"hello","proto":2147483648}'), ("wait", 2)], {"close": 1002, "error": "UNSUPPORTED_PROTO"}),
    ("hello_proto_2p32_plus_1", [("text", '{"type":"hello","proto":4294967297}'), ("wait", 2)], {"close": 1002, "error": "UNSUPPORTED_PROTO"}),
    ("hello_proto_1e10", [("text", '{"type":"hello","proto":1e10}'), ("wait", 2)], {"close": 1002, "error": "UNSUPPORTED_PROTO"}),
    ("hello_proto_1e400", [("text", '{"type":"hello","proto":1e400}'), ("wait", 2)], {"close": 1002, "error": "UNSUPPORTED_PROTO"}),
    ("hello_proto_bigint", [("text", '{"type":"hello","proto":' + BIG_INT_400 + "}"), ("wait", 2)], {"close": 1002, "error": "UNSUPPORTED_PROTO"}),
    ("hello_proto_neg", [("text", '{"type":"hello","proto":-1}'), ("wait", 2)], {"close": 1002, "error": "UNSUPPORTED_PROTO"}),
    ("hello_twice", [("text", HELLO), ("text", HELLO), ("wait", 1)], {"close": None, "reply": "welcome"}),
    # 형식
    ("bad_json_after_hello", [("text", HELLO), ("text", "{not json"), ("wait", 2)], {"close": 1002, "error": "BAD_JSON"}),
    ("json_array", [("text", HELLO), ("text", "[1,2,3]"), ("wait", 1)], {"close": None, "error": "UNKNOWN_TYPE"}),
    ("json_number", [("text", HELLO), ("text", "5"), ("wait", 1)], {"close": None, "error": "UNKNOWN_TYPE"}),
    ("json_null", [("text", HELLO), ("text", "null"), ("wait", 1)], {"close": None, "error": "UNKNOWN_TYPE"}),
    ("json_string", [("text", HELLO), ("text", '"ping"'), ("wait", 1)], {"close": None, "error": "UNKNOWN_TYPE"}),
    ("empty_text", [("text", HELLO), ("text", ""), ("wait", 1)], {"close": "any", "note": "빈 본문 — BAD_JSON 또는 UNKNOWN_TYPE"}),
    ("type_number", [("text", HELLO), ("text", '{"type":5}'), ("wait", 1)], {"close": None, "error": "UNKNOWN_TYPE"}),
    ("type_object", [("text", HELLO), ("text", '{"type":{"x":"ping"}}'), ("wait", 1)], {"close": None, "error": "UNKNOWN_TYPE"}),
    ("unknown_type", [("text", HELLO), ("text", '{"type":"subscribe_all"}'), ("wait", 1)], {"close": None, "error": "UNKNOWN_TYPE"}),
    ("dup_keys", [("text", HELLO), ("text", '{"type":"ping","type":"bogus"}'), ("wait", 1)], {"close": "any"}),
    ("deep_nesting", [("text", HELLO), ("text", '{"type":"ping","x":' + "[" * 1500 + "]" * 1500 + "}"), ("wait", 2)], {"close": "any", "note": "깊이 1,500"}),
    ("invalid_utf8", [("text", HELLO), ("frame", 1, b'{"type":"ping","x":"\xff\xfe"}', True), ("wait", 2)], {"close": 1007}),
    ("binary_frame", [("text", HELLO), ("frame", 2, b"\x00\x01", True), ("wait", 2)], {"close": 1003}),
    ("size_4096_ok", [("text", HELLO), ("text", '{"type":"ping","pad":"' + "a" * (4096 - 24) + '"}'), ("wait", 1)], {"close": None, "reply": "pong"}),
    ("size_4097", [("text", HELLO), ("text", '{"type":"ping","pad":"' + "a" * (4097 - 24) + '"}'), ("wait", 2)], {"close": 1009}),
    ("size_64k", [("text", HELLO), ("text", '{"type":"ping","pad":"' + "a" * 65000 + '"}'), ("wait", 2)], {"close": 1009}),
    ("multibyte_4096_bytes", [("text", HELLO), ("text", '{"type":"ping","pad":"' + "가" * 1360 + '"}'), ("wait", 1)], {"close": "any", "note": "글자 1,384 · 바이트 4,104"}),
    # 빠른 반복
    ("rate_21_pings", [("text", HELLO)] + [("text", '{"type":"ping"}')] * 21 + [("wait", 2)], {"close": 1008}),
    ("rate_19_pings", [("text", HELLO)] + [("text", '{"type":"ping"}')] * 18 + [("wait", 2)], {"close": None, "reply": "pong"}),
    ("rate_subscribe_storm", [("text", HELLO)] + [("text", sub([124 + i * 0.1, 33, 132, 39])) for i in range(15)] + [("wait", 3)], {"close": None, "reply": "snapshot"}),
    # subscribe 값
    ("bbox_not_array", [("text", HELLO), ("text", '{"type":"subscribe","bbox":"124,33,132,39"}'), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_three", [("text", HELLO), ("text", sub([124, 33, 132])), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_strings", [("text", HELLO), ("text", sub(["124", "33", "132", "39"])), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_null_item", [("text", HELLO), ("text", sub([124, None, 132, 39])), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_missing", [("text", HELLO), ("text", '{"type":"subscribe"}'), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_inverted", [("text", HELLO), ("text", sub([132, 33, 124, 39])), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_antimeridian", [("text", HELLO), ("text", sub([170, -10, -170, 10])), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_out_of_range", [("text", HELLO), ("text", sub([124, 33, 181, 39])), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_1e400", [("text", HELLO), ("text", raw_sub("[124,33,1e400,39]")), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_1e308", [("text", HELLO), ("text", raw_sub("[124,33,1e308,39]")), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_bigint_400", [("text", HELLO), ("text", raw_sub("[124,33," + BIG_INT_400 + ",39]")), ("wait", 2)], {"close": None, "error": "BAD_BBOX",
                                                                                                             "note": "알려진 한계(ADR-017 S4)는 zoom 만 — bbox 는?"}),
    ("bbox_2p63", [("text", HELLO), ("text", raw_sub("[124,33,9223372036854775808,39]")), ("wait", 1)], {"close": None, "error": "BAD_BBOX"}),
    ("bbox_world_zoom6", [("text", HELLO), ("text", sub([-180, -90, 180, 90], 6)), ("wait", 1)], {"close": None, "error": "BBOX_TOO_LARGE"}),
    ("bbox_world_zoom5", [("text", HELLO), ("text", sub([-180, -90, 180, 90], 5)), ("wait", 3)], {"close": None, "reply": "snapshot"}),
    ("zoom_negative", [("text", HELLO), ("text", sub(zoom=-5)), ("wait", 2)], {"close": None, "reply": "snapshot"}),
    ("zoom_25", [("text", HELLO), ("text", sub(zoom=25)), ("wait", 2)], {"close": None, "reply": "snapshot"}),
    ("zoom_1e10", [("text", HELLO), ("text", sub(zoom=1e10)), ("wait", 2)], {"close": None, "reply": "snapshot"}),
    ("zoom_1e400_world", [("text", HELLO), ("text", raw_sub("[-180,-90,180,90]", "1e400")), ("wait", 2)], {"close": None, "error": "BBOX_TOO_LARGE"}),
    ("zoom_string", [("text", HELLO), ("text", sub(zoom="3")), ("wait", 2)], {"close": None, "reply": "snapshot"}),
    ("zoom_null_world", [("text", HELLO), ("text", raw_sub("[-180,-90,180,90]", "null")), ("wait", 2)],
     {"close": None, "error": "BBOX_TOO_LARGE"}),
    ("zoom_bigint_400", [("text", HELLO), ("text", raw_sub("[124,33,132,39]", BIG_INT_400)), ("wait", 2)], {"close": 1002, "error": "BAD_MESSAGE",
                                                                                                             "note": "알려진 한계(ADR-017 S4)"}),
    ("detail_number", [("text", HELLO), ("text", sub(detail=5)), ("wait", 2)], {"close": None, "reply": "snapshot"}),
    # select · select_ship · layers · resync
    ("select_number", [("text", HELLO), ("text", '{"type":"select","hex":7454209}'), ("wait", 1)], {"close": None, "error": "BAD_HEX"}),
    ("select_bad", [("text", HELLO), ("text", '{"type":"select","hex":"ZZZZZZ"}'), ("wait", 1)], {"close": None, "error": "BAD_HEX"}),
    ("select_object", [("text", HELLO), ("text", '{"type":"select","hex":{"a":1}}'), ("wait", 1)], {"close": None, "error": "BAD_HEX"}),
    ("select_missing_then_null", [("text", HELLO), ("text", '{"type":"select"}'), ("text", '{"type":"select","hex":null}'), ("wait", 1)], {"close": None}),
    ("select_unicode_upper", [("text", HELLO), ("text", '{"type":"select","hex":"７１be01"}'), ("wait", 1)], {"close": None, "error": "BAD_HEX"}),
    ("select_ship_number", [("text", HELLO), ("text", '{"type":"select_ship","mmsi":440123450}'), ("wait", 1)], {"close": None, "error": "BAD_MMSI"}),
    ("select_ship_short", [("text", HELLO), ("text", '{"type":"select_ship","mmsi":"44012345"}'), ("wait", 1)], {"close": None, "error": "BAD_MMSI"}),
    ("select_ship_arabic", [("text", HELLO), ("text", '{"type":"select_ship","mmsi":"٤٤٠١٢٣٤٥٠"}'), ("wait", 1)], {"close": None, "error": "BAD_MMSI"}),
    ("select_ship_unknown", [("text", HELLO), ("text", '{"type":"select_ship","mmsi":"999999999"}'), ("wait", 2)], {"close": None, "reply": "ship_selected"}),
    ("layers_string", [("text", HELLO), ("text", '{"type":"layers","aircraft":"true"}'), ("wait", 1)], {"close": None, "error": "BAD_LAYERS"}),
    ("layers_number", [("text", HELLO), ("text", '{"type":"layers","ships":1}'), ("wait", 1)], {"close": None, "error": "BAD_LAYERS"}),
    ("layers_empty", [("text", HELLO), ("text", '{"type":"layers"}'), ("wait", 1)], {"close": None}),
    ("layers_null", [("text", HELLO), ("text", '{"type":"layers","ships":null}'), ("wait", 1)], {"close": None, "error": "BAD_LAYERS"}),
    ("resync_bogus", [("text", HELLO), ("text", '{"type":"resync","scope":"bogus"}'), ("wait", 1)], {"close": None, "error": "BAD_RESYNC"}),
    ("resync_number", [("text", HELLO), ("text", '{"type":"resync","scope":5}'), ("wait", 1)], {"close": None, "error": "BAD_RESYNC"}),
    ("resync_before_subscribe", [("text", HELLO), ("text", '{"type":"resync"}'), ("wait", 2)], {"close": None}),
    ("pong_unsolicited", [("text", HELLO), ("text", '{"type":"pong"}'), ("wait", 1)], {"close": None}),
    ("resume_without_pause", [("text", HELLO), ("text", '{"type":"resume"}'), ("wait", 1)], {"close": None}),
]


def run_scenario(base_host, port, origin, name, steps, expect, validator):
    ws = None
    for attempt in range(6):
        ws = WS(base_host, port, origin)
        if ws.handshake_status == 101:
            # 상한(1013)으로 바로 닫히는지 짧게 본다
            break
        ws.sock.close()
        time.sleep(3)
    rec = {"name": name, "handshake": ws.status_line, "sent": 0, "messages": [], "close": None, "errors": [], "schema_errors": [], "verdict": "ok", "why": []}
    if ws.handshake_status != 101:
        rec["verdict"] = "fail"
        rec["why"].append("handshake " + ws.status_line)
        return rec
    msgs, closed = [], None
    try:
        for st in steps:
            if closed:
                break
            if st[0] == "text":
                try:
                    ws.send(st[1])
                    rec["sent"] += 1
                except OSError as e:
                    closed = closed or (1006, repr(e))
            elif st[0] == "frame":
                try:
                    ws.frame(st[1], st[2], fin=st[3])
                    rec["sent"] += 1
                except OSError as e:
                    closed = closed or (1006, repr(e))
            elif st[0] == "wait":
                got, c = ws.drain(st[1])
                msgs += got
                closed = closed or c
        if not closed:
            got, c = ws.drain(0.3)
            msgs += got
            closed = c
    finally:
        if not closed:
            ws.close()
        else:
            try:
                ws.sock.close()
            except OSError:
                pass
    if closed and closed[0] == 1013:
        rec["verdict"] = "retry"
    rec["close"] = closed
    rec["types"] = sorted({m.get("type", "?") for m in msgs if isinstance(m, dict)})
    rec["errors"] = [m for m in msgs if isinstance(m, dict) and m.get("type") == "error"]
    rec["schema_errors"] = schema_errors(validator, [m for m in msgs if isinstance(m, dict) and "_raw" not in m])
    rec["messages"] = len(msgs)
    # 판정
    want_close = expect.get("close")
    if want_close != "any":
        got_code = closed[0] if closed else None
        if want_close is None and got_code is not None:
            rec["why"].append(f"열린 채여야 하는데 닫힘 {closed}")
        elif want_close is not None and got_code != want_close:
            rec["why"].append(f"닫힘 {want_close} 기대, 실제 {closed}")
    if expect.get("error"):
        codes = [e.get("code") for e in rec["errors"]]
        if expect["error"] not in codes:
            rec["why"].append(f"error {expect['error']} 기대, 실제 {codes or '없음'}")
    for t in [expect.get("reply")] + list(expect.get("also", [])):
        if t and t not in rec["types"]:
            rec["why"].append(f"{t} 를 받지 못함(받은 종류 {rec['types']})")
    if rec["schema_errors"]:
        rec["why"].append(f"스키마 위반 {len(rec['schema_errors'])}")
    if rec["why"] and rec["verdict"] == "ok":
        rec["verdict"] = "fail"
    rec["expect"] = expect
    return rec


def leak_check(host, port, origin, n=20):
    """나쁜 연결(형식 오류로 닫힘)을 n 번 연 뒤에도 정상 연결이 되는가 — 연결 상한 예약이 풀리는지(갇힌 세션 없음)."""
    for _ in range(n):
        ws = WS(host, port, origin)
        if ws.handshake_status == 101:
            ws.send("{")
            ws.drain(1)
        ws.sock.close()
        time.sleep(0.25)
    time.sleep(1)
    ws = WS(host, port, origin)
    ok = ws.handshake_status == 101
    msgs, closed = [], None
    if ok:
        ws.send(HELLO)
        msgs, closed = ws.drain(2, stop=lambda m: m.get("type") == "welcome")
        ws.close()
    return {"name": f"leak_after_{n}_bad", "verdict": "ok" if ok and any(m.get("type") == "welcome" for m in msgs) else "fail",
            "close": closed, "types": [m.get("type") for m in msgs]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8701")
    ap.add_argument("--origin")
    ap.add_argument("--only")
    ap.add_argument("--out", default=OUT_DIR)
    a = ap.parse_args()
    from urllib.parse import urlparse
    u = urlparse(a.base)
    if u.port not in ALLOWED_PORTS:
        raise SystemExit(f"QA 는 격리 스택만: {a.base}")
    origin = a.origin or f"http://localhost:{u.port}"
    validator = load_validator()
    only = re.compile(a.only) if a.only else None
    os.makedirs(a.out, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    jl = os.path.join(a.out, f"ws-{stamp}.jsonl")
    recs = []
    with open(jl, "w") as f:
        # 다른 Origin — 핸드셰이크 거절(403)
        if not only or only.search("origin"):
            w = WS(u.hostname, u.port, "http://evil.example")
            rec = {"name": "origin_foreign", "handshake": w.status_line, "verdict": "ok" if w.handshake_status == 403 else "fail"}
            w.sock.close()
            recs.append(rec)
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        for name, steps, expect in SCENARIOS:
            if only and not only.search(name):
                continue
            for attempt in range(3):
                rec = run_scenario(u.hostname, u.port, origin, name, steps, expect, validator)
                if rec["verdict"] != "retry":
                    break
                time.sleep(5)
            recs.append(rec)
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
            print(f"{rec['verdict']:5} {name} close={rec.get('close')} types={rec.get('types')} {'; '.join(rec.get('why', []))}", file=sys.stderr)
            time.sleep(0.6)  # edge WS 핸드셰이크 5 r/s
        if not only or only.search("leak"):
            rec = leak_check(u.hostname, u.port, origin)
            recs.append(rec)
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
            print(f"{rec['verdict']:5} {rec['name']} {rec.get('types')}", file=sys.stderr)
    md = jl.replace(".jsonl", ".md")
    fails = [r for r in recs if r["verdict"] != "ok"]
    with open(md, "w") as f:
        f.write(f"# WS 점검 결과 — {stamp}\n\n- 대상: {a.base}/ws/v1 (Origin {origin}) · 시나리오 {len(recs)} · 기대와 다름 {len(fails)}"
                f" · 스키마 검증 {'jsonschema' if validator else '건너뜀(jsonschema 없음)'}\n- 명령: `python3 tools/qa/ws_probe.py`\n\n")
        f.write("| 시나리오 | 판정 | 닫힘 | 받은 종류 | error code | 까닭 |\n|---|---|---|---|---|---|\n")
        for r in recs:
            codes = ",".join(e.get("code", "?") for e in r.get("errors", []))
            f.write(f"| {r['name']} | {r['verdict']} | {r.get('close') or ''} | {','.join(r.get('types', []) or [])} | {codes} | {'; '.join(r.get('why', []))} |\n")
        se = [(r["name"], e) for r in recs for e in r.get("schema_errors", [])]
        if se:
            f.write("\n## 스키마 위반\n\n")
            for n, e in se[:50]:
                f.write(f"- {n}: `{e['type']}` {e['path']} — {e['error']}\n")
    print(f"done: {len(recs)} scenarios, {len(fails)} unexpected → {md}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
