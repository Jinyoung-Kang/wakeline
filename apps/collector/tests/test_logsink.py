"""계약 v5 §C2 · ADR-018 — 로그 싱크: WARN·ERROR 를 가려서(C5) Redis 스트림 wakeline:logs 로.

LogEvent 스키마(schemas/log_event.v1.json) · 지문 · 10 s 억제 · 대기열 상한(500건 · 2 MiB) · 8 KiB 자르기 순서 ·
50건/1 s 전송 · Redis 장애 백오프(1 → 30 s) · 작업 스레드에서 부른 emit · 재귀 금지 · 설치/해제.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import re
import socket
import threading
import time

import orjson
import pytest
from conftest import ROOT
from fakes import FakeRedis
from jsonschema import Draft202012Validator, FormatChecker

from wakeline_collector import logsink as ls
from wakeline_collector import masking

SCHEMA = json.loads((ROOT / "schemas" / "log_event.v1.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
TS_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")


class Clock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def entries(r: FakeRedis) -> list[dict]:
    return [orjson.loads(f["e"]) for _sid, f in r.streams.get(ls.STREAM_LOGS, [])]


def logger_for(sink: logging.Handler, name: str = "test.logsink") -> logging.Logger:
    """싱크만 붙은 로거(루트로 올리지 않는다 — 시험끼리 섞이지 않게)."""
    lg = logging.getLogger(name)
    lg.handlers[:] = [sink]
    lg.propagate = False
    lg.setLevel(logging.DEBUG)
    return lg


def raise_and_catch(exc: BaseException) -> BaseException:
    try:
        raise exc
    except BaseException as e:  # noqa: BLE001
        return e


@pytest.fixture(autouse=True)
def _clean_secrets():
    yield
    masking._SECRETS.clear()


# ── 수준 · 모양 ─────────────────────────────────────────────────


def test_only_warn_and_error_are_queued_and_levels_are_mapped():
    sink = ls.LogSink("collector", FakeRedis(), clock=Clock())
    lg = logger_for(sink)
    lg.debug("debug a")
    lg.info("info b")
    lg.warning("warn c")
    lg.error("error d")
    lg.critical("critical e")
    got = [orjson.loads(js) for js, _n in sink.pending()]
    assert [(e["level"], e["message"]) for e in got] == [("WARN", "warn c"), ("ERROR", "error d"), ("ERROR", "critical e")]
    assert sink.level == logging.WARNING


async def test_event_matches_the_schema_and_carries_the_contract_fields():
    r = FakeRedis()
    sink = ls.LogSink("collector", r)
    lg = logger_for(sink, "wakeline.test.shape")
    lg.warning("region poll slow: %d ms", 1234)
    lg.error("kma radar failed", exc_info=raise_and_catch(ValueError("not gzip")))
    assert await sink.send_pending() == 2
    warn, err = entries(r)
    for e in (warn, err):
        assert not list(VALIDATOR.iter_errors(e)), list(VALIDATOR.iter_errors(e))
        assert e["v"] == 1 and e["service"] == "collector" and e["request_id"] is None
        assert TS_RE.match(e["ts"])
        suffix = f":{os.getpid()}"
        assert e["instance"] == socket.gethostname()[: 64 - len(suffix)] + suffix  # 호스트명:pid(pid 는 늘 남긴다)
        assert e["thread"] == threading.current_thread().name
        assert e["logger"] == "wakeline.test.shape" and re.fullmatch(r"[0-9a-f]{16}", e["fp"])
        assert e["suppressed"] == 0
        assert e["context"]["func"] == "test_event_matches_the_schema_and_carries_the_contract_fields"
        assert isinstance(e["context"]["line"], int) and e["context"]["module"] == "test_logsink"
    assert warn["message"] == "region poll slow: 1234 ms" and warn["exception"] is None  # 예외 없는 WARN 은 exception null
    assert err["exception"]["type"] == "ValueError" and err["exception"]["message"] == "not gzip"
    assert err["exception"]["stack"].startswith("Traceback (most recent call last):")
    assert "ValueError: not gzip" in err["exception"]["stack"]


def test_exception_type_is_qualified_outside_builtins_and_empty_message_is_null():
    from redis.exceptions import ConnectionError as RedisConnectionError

    sink = ls.LogSink("ais", FakeRedis(), clock=Clock())
    lg = logger_for(sink)
    lg.error("a", exc_info=raise_and_catch(RedisConnectionError("refused")))
    lg.error("b", exc_info=raise_and_catch(TimeoutError()))
    a, b = (orjson.loads(js) for js, _n in sink.pending())
    assert a["exception"]["type"] == "redis.exceptions.ConnectionError"
    assert b["exception"]["type"] == "TimeoutError" and b["exception"]["message"] is None


async def test_xadd_uses_field_e_and_approximate_maxlen_3000():
    calls: list[tuple] = []

    class Rec(FakeRedis):
        async def xadd(self, stream, fields, **kw):
            calls.append((stream, dict(fields), kw))
            return await super().xadd(stream, fields, **kw)

    sink = ls.LogSink("collector", Rec())
    logger_for(sink).warning("one")
    await sink.send_pending()
    assert len(calls) == 1
    stream, fields, kw = calls[0]
    assert stream == "wakeline:logs" and list(fields) == ["e"] and kw == {"maxlen": 3000, "approximate": True}
    assert (ls.STREAM_LOGS, ls.STREAM_MAXLEN) == ("wakeline:logs", 3000)


# ── 가림(C5) ─────────────────────────────────────────────────────


def test_message_exception_and_stack_are_masked_even_without_a_mask_filter():
    masking.register_secrets("VeryS3cretRedisPw")
    sink = ls.LogSink("collector", FakeRedis(), clock=Clock())
    assert not sink.filters  # MaskFilter 없이 만든 싱크도 스스로 가린다
    lg = logger_for(sink)
    exc = raise_and_catch(RuntimeError("provider said token=tok_zz9 and VeryS3cretRedisPw"))
    lg.error("GET https://h.test/v?serviceKey=SK_77&key=QK_88 pw=%s", "VeryS3cretRedisPw", exc_info=exc)
    ((js, _n),) = sink.pending()
    for leaked in ("tok_zz9", "VeryS3cretRedisPw", "SK_77", "QK_88"):
        assert leaked not in js
    e = orjson.loads(js)
    assert e["message"] == "GET https://h.test/v?serviceKey=***&key=*** pw=***"
    assert e["exception"]["message"] == "provider said token=*** and ***"
    assert "RuntimeError: provider said token=*** and ***" in e["exception"]["stack"]


@pytest.mark.parametrize("with_filter", [False, True])
def test_lone_surrogates_are_escaped_not_dropped(with_filter):
    """surrogateescape 로 읽은 바이트(UTF-8 이 아닌 파일 이름 등)가 든 WARN·ERROR 도 싣는다 — UTF-8 로 적을 수 없는 그 글자만
    \\udcXX 로 적는다(지문 · JSON 직렬화가 UTF-8 을 요구한다)."""
    sink = ls.LogSink("collector", FakeRedis(), clock=Clock())
    if with_filter:
        masking.install_log_masking(sink)
    lg = logger_for(sink, "odd.caf\udce9")
    name = b"/data/caf\xe9.json".decode("utf-8", "surrogateescape")
    lg.error("cannot open %s", name, exc_info=raise_and_catch(OSError(f"bad {name}")))
    assert sink.dropped == 0
    ((js, _n),) = sink.pending()
    e = orjson.loads(js)
    assert e["message"] == "cannot open /data/caf\\udce9.json" and e["logger"] == "odd.caf\\udce9"
    assert e["exception"]["message"] == "bad /data/caf\\udce9.json"
    assert "OSError: bad /data/caf\\udce9.json" in e["exception"]["stack"]
    assert not list(VALIDATOR.iter_errors(e))


# ── 지문 · 억제 ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,template",
    [
        ("took 123 ms for 42 aircraft", "took # ms for # aircraft"),
        ("run 9f86d081884c7d65 failed", "run # failed"),
        ("object at 0x7f3a2b1c9d00 closed", "object at # closed"),
        ("KeyError: 'abc'", "KeyError: '…'"),
        ('got "x y 1" back', "got '…' back"),
        ("cafe 12 beef", "cafe # beef"),  # 8자 미만 16진 낱말은 그대로(숫자열만 #)
        ("", ""),
    ],
)
def test_message_template(text, template):
    assert ls.message_template(text) == template


def test_fingerprint_is_sha256_prefix_of_service_logger_type_template():
    fp = ls.fingerprint("collector", "jobs.aircraft", "ValueError", "took 5 ms")
    want = hashlib.sha256(b"collector\njobs.aircraft\nValueError\ntook # ms").hexdigest()[:16]
    assert fp == want
    assert fp == ls.fingerprint("collector", "jobs.aircraft", "ValueError", "took 91234 ms")  # 숫자만 다르면 같은 묶음
    assert fp != ls.fingerprint("ais", "jobs.aircraft", "ValueError", "took 5 ms")
    assert fp != ls.fingerprint("collector", "jobs.other", "ValueError", "took 5 ms")
    assert fp != ls.fingerprint("collector", "jobs.aircraft", "", "took 5 ms")


def test_same_fingerprint_is_sent_once_per_10s_and_the_next_entry_carries_the_suppressed_count():
    clock = Clock()
    sink = ls.LogSink("collector", FakeRedis(), clock=clock)
    lg = logger_for(sink)
    for i in range(5):  # 0 · 2 · 4 · 6 · 8 s — 첫 건만
        lg.warning("upstream 503 after %d ms", 100 + i)
        clock.t += 2
    lg.warning("a different problem")  # 다른 지문은 억제하지 않는다
    clock.t = 1000.0 + ls.DEDUP_WINDOW_S  # 첫 전송 10 s 뒤
    lg.warning("upstream 503 after %d ms", 999)
    got = [orjson.loads(js) for js, _n in sink.pending()]
    assert [(e["message"], e["suppressed"]) for e in got] == [
        ("upstream 503 after 100 ms", 0),
        ("a different problem", 0),
        ("upstream 503 after 999 ms", 4),
    ]
    assert sink.suppressed == 4 and ls.DEDUP_WINDOW_S == 10.0


async def test_burst_then_silence_still_reports_the_suppressed_count(caplog):
    """ADR-018 '억제 수는 남긴다': 같은 오류가 10 s 안에 20번 나고 끊기면 스트림에는 1건(suppressed 0)뿐이다 — 나머지 19건은
    자기 지표 log_suppressed(기동 뒤 누계)에 남고, 종료 때 다음 항목에 실리지 못한 억제 수를 표준 출력에 적는다."""
    r = FakeRedis()
    sink = ls.LogSink("collector", r, clock=Clock())
    lg = logger_for(sink)
    for i in range(20):
        lg.error("upstream 503 after %d ms", i)
    caplog.set_level(logging.INFO, logger="logsink")
    await sink.aclose()
    assert [(e["message"], e["suppressed"]) for e in entries(r)] == [("upstream 503 after 0 ms", 0)]
    assert sink.metrics() == {"log_sent": "1", "log_dropped": "0", "log_suppressed": "19"}
    assert ls.sink_metrics(sink) == sink.metrics()
    notes = [rec.getMessage() for rec in caplog.records if rec.name == "logsink"]
    assert any("19 suppressed" in m and "1 fingerprint" in m for m in notes), notes


@pytest.mark.parametrize("failure", ["too-big", "raises"])
def test_an_entry_that_is_not_queued_gives_its_suppressed_count_back(monkeypatch, failure):
    """억제 창을 연 항목을 만들지 못하면(8 KiB 에 못 맞춤 · 만드는 중 예외) 그 항목이 실어 가던 억제 수는 다음 항목이 싣고,
    보낸 것이 없으므로 다음 항목도 억제하지 않는다. 버린 레코드는 log_dropped 에."""
    clock = Clock()
    sink = ls.LogSink("collector", FakeRedis(), clock=clock)
    lg = logger_for(sink)
    for i in range(4):  # 첫 건만 가고 3건 억제
        lg.warning("x %d", i)
    clock.t += ls.DEDUP_WINDOW_S
    real = ls.fit_event

    def broken(ev, lost=None):
        if failure == "raises":
            raise RuntimeError("boom")
        return None

    monkeypatch.setattr(ls, "fit_event", broken)
    lg.warning("x %d", 4)
    monkeypatch.setattr(ls, "fit_event", real)
    lg.warning("x %d", 5)  # 같은 창이지만 보낸 것이 없다
    got = [orjson.loads(js) for js, _n in sink.pending()]
    assert [(e["message"], e["suppressed"]) for e in got] == [("x 0", 0), ("x 5", 3)]
    assert (sink.dropped, sink.suppressed) == (1, 3)


def test_dedup_table_stays_bounded():
    clock = Clock()
    sink = ls.LogSink("collector", FakeRedis(), clock=clock, queue_max=10_000, queue_max_bytes=1 << 30)
    lg = logger_for(sink)
    for i in range(ls.DEDUP_MAX_FPS * 2):
        lg.warning("problem %s", "x" * (i % 50) + chr(0x4E00 + i))  # 지문이 모두 다르다
    assert len(sink._recent) <= ls.DEDUP_MAX_FPS


# ── 대기열 상한 · 8 KiB ─────────────────────────────────────────


def test_queue_keeps_500_entries_dropping_the_oldest_and_counts_them():
    clock = Clock()
    sink = ls.LogSink("collector", FakeRedis(), clock=clock)
    lg = logger_for(sink)
    for i in range(510):
        lg.warning("n=%d", i)
        clock.t += ls.DEDUP_WINDOW_S  # 억제 창 밖 — 모두 대기열로
    got = [orjson.loads(js)["message"] for js, _n in sink.pending()]
    assert (ls.QUEUE_MAX, len(got), sink.dropped) == (500, 500, 10)
    assert got[0] == "n=10" and got[-1] == "n=509"


def test_queue_keeps_at_most_2_MiB():
    clock = Clock()
    sink = ls.LogSink("collector", FakeRedis(), clock=clock)
    lg = logger_for(sink)
    for _ in range(300):
        lg.warning("가" * 4000)  # 한 건 ≈ 8 KiB(UTF-8 3바이트 × 자른 뒤)
        clock.t += ls.DEDUP_WINDOW_S
    pend = sink.pending()
    total = sum(n for _js, n in pend)
    assert ls.QUEUE_MAX_BYTES == 2 * 1024 * 1024
    assert total <= ls.QUEUE_MAX_BYTES and total + max(n for _js, n in pend) > ls.QUEUE_MAX_BYTES
    assert sink.dropped == 300 - len(pend) > 0


class GatedRedis(FakeRedis):
    """파이프라인 실행이 gate 가 열릴 때까지 멈춘다(보내는 중인 묶음이 있는 동안을 만든다)."""

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()

    def pipeline(self, transaction: bool = False):
        p = super().pipeline(transaction)
        orig = p.execute

        async def execute():
            await self.gate.wait()
            return await orig()

        p.execute = execute  # type: ignore[method-assign]
        return p


@pytest.mark.xfail(strict=True, reason="v5-C2: 고치기 전 — 보내는 중인 묶음을 상한에 세지 않아 550건 · 2.4 MiB 까지 붙잡는다")
@pytest.mark.parametrize("text,more", [("n=%d", 550), ("가" * 4000 + " %d", 300)])
async def test_queue_cap_counts_the_batch_being_sent(text, more):
    """대기열 상한(500건 · 2 MiB)은 보내는 중인 묶음(≤ 50건)까지 센다 — Redis 가 느린 동안에도 프로세스가 붙잡는 항목은 상한 안.
    넘으면 대기열의 오래된 것부터 버린다(보내는 중인 묶음은 건드리지 않는다)."""
    r = GatedRedis()
    clock = Clock()
    sink = ls.LogSink("collector", r, clock=clock)
    lg = logger_for(sink)
    for i in range(ls.FLUSH_BATCH):
        lg.warning(text, i)
        clock.t += ls.DEDUP_WINDOW_S
    send = asyncio.create_task(sink.send_pending())
    await asyncio.sleep(0.01)  # 첫 묶음 50건이 보내는 중
    for i in range(ls.FLUSH_BATCH, ls.FLUSH_BATCH + more):
        lg.warning(text, i)
        clock.t += ls.DEDUP_WINDOW_S
    pend = sink.pending()
    assert len(pend) <= ls.QUEUE_MAX and sum(n for _js, n in pend) <= ls.QUEUE_MAX_BYTES
    assert sink.dropped == ls.FLUSH_BATCH + more - len(pend)
    r.gate.set()
    await send
    assert len(entries(r)) == len(pend) and sink.sent + sink.dropped == ls.FLUSH_BATCH + more


def _event(message: str, exc_message: str | None, stack: str) -> dict:
    return {
        "v": 1,
        "ts": "2026-09-29T00:00:00.000Z",
        "service": "collector",
        "instance": "h:1",
        "level": "ERROR",
        "logger": "x",
        "thread": "MainThread",
        "message": message,
        "exception": {"type": "ValueError", "message": exc_message, "stack": stack},
        "fp": "0123456789abcdef",
        "request_id": None,
        "context": {},
        "suppressed": 0,
    }


def _kept_and_cut(text: str) -> tuple[str, int]:
    m = re.fullmatch(r"(.*)…\(잘림 (\d+)자\)", text, flags=re.S)
    assert m, text[-40:]
    return m.group(1), int(m.group(2))


def test_fit_cuts_the_stack_first_and_only_as_much_as_needed():
    stack = "".join(f"  File frame{i}\n" for i in range(3000))
    raw = ls.fit_event(_event("short", "boom", stack))
    assert raw is not None and ls.ENTRY_MAX_BYTES - 32 < len(raw) <= ls.ENTRY_MAX_BYTES == 8 * 1024
    e = orjson.loads(raw)
    kept, cut = _kept_and_cut(e["exception"]["stack"])
    assert stack.startswith(kept) and len(kept) + cut == len(stack)
    assert e["message"] == "short" and e["exception"]["message"] == "boom"
    assert not list(VALIDATOR.iter_errors(e))


def test_fit_then_cuts_the_exception_message_then_the_message():
    msg, exc_msg = "가" * 3900, "나" * 1990  # 스키마 상한 안이지만 합치면 8 KiB 를 넘는다(3바이트 글자)
    e = orjson.loads(ls.fit_event(_event(msg, exc_msg, "s" * 5000)) or b"null")
    assert _kept_and_cut(e["exception"]["stack"]) == ("", 5000)  # 스택 전부
    kept, cut = _kept_and_cut(e["exception"]["message"])
    assert kept == "" and cut == len(exc_msg)  # 그다음 예외 메시지 전부
    kept, cut = _kept_and_cut(e["message"])  # 마지막으로 메시지를 맞을 만큼
    assert msg.startswith(kept) and len(kept) + cut == len(msg) and len(kept) > 1000
    assert len(orjson.dumps(e)) <= ls.ENTRY_MAX_BYTES and not list(VALIDATOR.iter_errors(e))


def test_fit_applies_schema_field_limits_with_the_marker():
    e = orjson.loads(ls.fit_event(_event("m" * 5000, "x" * 2500, "s" * 100)) or b"null")
    assert len(e["message"]) <= 4000 and len(e["exception"]["message"]) <= 2000
    kept, cut = _kept_and_cut(e["message"])
    assert len(kept) + cut == 5000
    kept, cut = _kept_and_cut(e["exception"]["message"])
    assert len(kept) + cut == 2500
    assert e["exception"]["stack"] == "s" * 100
    assert not list(VALIDATOR.iter_errors(e))


def test_real_huge_traceback_fits_and_validates():
    def deep(n: int) -> None:
        if n == 0:
            raise RuntimeError("bottom " + "z" * 3000)
        deep(n - 1)

    sink = ls.LogSink("collector", FakeRedis(), clock=Clock())
    try:
        deep(150)
    except RuntimeError as e:
        logger_for(sink).exception("deep failure %s", "q" * 6000, exc_info=e)
    ((js, n),) = sink.pending()
    assert n == len(js.encode()) <= ls.ENTRY_MAX_BYTES
    assert not list(VALIDATOR.iter_errors(orjson.loads(js)))


def _whole(text: str) -> int:
    """잘린 칸이 말하는 원문 길이 = 남긴 글자 + 잘림 표시의 N."""
    kept, cut = _kept_and_cut(text)
    return len(kept) + cut


@pytest.mark.parametrize("masked_by", ["sink", "root-handler-filter", "sink-filter"])
def test_cut_marker_counts_the_whole_text_even_beyond_the_mask_limit(masked_by):
    """계약 v5 §C1 '…(잘림 N자)': 메시지·예외 메시지·스택이 가림 상한(LOG_LIMIT 100,000자)보다 길어도 남긴 글자 + N = 가린 원문 전체.
    main 처럼 표준 출력 핸들러의 MaskFilter 가 먼저 레코드를 가린 경우(root-handler-filter), 싱크 자신의 MaskFilter(sink-filter),
    필터 없이 싱크가 스스로 가린 경우(sink) 모두."""
    sink = ls.LogSink("collector", FakeRedis(), clock=Clock())
    lg = logger_for(sink)
    if masked_by == "root-handler-filter":
        out = logging.StreamHandler(io.StringIO())
        masking.install_log_masking(out)
        lg.handlers[:] = [out, sink]
    elif masked_by == "sink-filter":
        masking.install_log_masking(sink)
    big = masking.LOG_LIMIT + 50_000
    exc = raise_and_catch(RuntimeError("e" * big))
    stack_len = len(logging.Formatter().formatException((RuntimeError, exc, exc.__traceback__)))
    lg.error("m" * big, exc_info=exc)
    ((js, n),) = sink.pending()
    e = orjson.loads(js)
    assert n <= ls.ENTRY_MAX_BYTES and not list(VALIDATOR.iter_errors(e))
    assert _whole(e["message"]) == big
    assert _whole(e["exception"]["message"]) == big
    assert _whole(e["exception"]["stack"]) == stack_len > masking.LOG_LIMIT


def test_a_record_is_masked_once_however_many_handlers_carry_the_filter(monkeypatch):
    """가림은 긴 글에서 비싸다(정규식 여러 개 × 글자 수) — 표준 출력 핸들러의 MaskFilter · 싱크의 MaskFilter · 싱크의 _build 가
    같은 레코드를 따로 가리면 emit 을 부른 스레드(이벤트 루프)가 세 배로 멈춘다. 한 레코드는 한 번만 가린다."""
    calls: list[int] = []
    real = masking.mask

    def counting(text, limit=4000):
        if text is not None and len(text) > 1000:
            calls.append(len(text))
        return real(text, limit)

    monkeypatch.setattr(masking, "mask", counting)
    monkeypatch.setattr(ls, "mask", counting)
    sink = ls.LogSink("collector", FakeRedis(), clock=Clock())
    out = logging.StreamHandler(io.StringIO())
    masking.install_log_masking(out, sink)
    lg = logger_for(sink)
    lg.handlers[:] = [out, sink]
    lg.warning("x" * 5000)
    assert calls == [5000]
    assert orjson.loads(sink.pending()[0][0])["message"].startswith("x" * 3000)


# ── 전송 · 깨우기 · 백오프 ──────────────────────────────────────


class CountingRedis(FakeRedis):
    def __init__(self) -> None:
        super().__init__()
        self.batches: list[int] = []

    def pipeline(self, transaction: bool = False):
        p = super().pipeline(transaction)
        orig = p.execute

        async def execute():
            self.batches.append(len(p._ops))
            return await orig()

        p.execute = execute  # type: ignore[method-assign]
        return p


async def test_flush_sends_everything_in_batches_of_50():
    r = CountingRedis()
    clock = Clock()
    sink = ls.LogSink("collector", r, clock=clock)
    lg = logger_for(sink)
    for i in range(120):
        lg.warning("n=%d", i)
        clock.t += ls.DEDUP_WINDOW_S
    assert await sink.send_pending() == 120
    assert r.batches == [50, 50, 20] and ls.FLUSH_BATCH == 50
    assert [e["message"] for e in entries(r)] == [f"n={i}" for i in range(120)]
    assert (
        sink.sent == 120
        and sink.pending() == []
        and sink.metrics() == {"log_sent": "120", "log_dropped": "0", "log_suppressed": "0"}
    )


async def test_flusher_sends_every_second_and_wakes_early_at_50():
    r = FakeRedis()
    sink = ls.LogSink("collector", r, flush_every_s=0.3)
    lg = logger_for(sink)
    sink.start(attach=False)
    try:
        lg.warning("tick")
        await asyncio.sleep(0.1)
        assert entries(r) == []  # 아직 틱 전
        await asyncio.sleep(0.4)
        assert len(entries(r)) == 1  # 틱에 보냈다
        sink.flush_every_s = 30.0
        await asyncio.sleep(0.35)  # 긴 주기로 바뀐 뒤의 대기에 들어가게
        for i in range(49):
            lg.warning("burst %s", chr(0x4E00 + i))
        await asyncio.sleep(0.1)
        assert len(entries(r)) == 1  # 49건은 틱을 기다린다
        lg.warning("burst fifty")
        await _wait(lambda: len(entries(r)) == 51, 1.0)  # 50건째가 깨운다
    finally:
        await sink.aclose()
    assert ls.FLUSH_EVERY_S == 1.0


async def test_emit_from_a_worker_thread_wakes_the_flusher():
    r = FakeRedis()
    sink = ls.LogSink("collector", r, flush_every_s=30.0)
    lg = logger_for(sink)
    sink.start(attach=False)
    try:

        def work() -> str:
            for i in range(50):
                lg.warning("thread burst %s", chr(0x4E00 + i))
            return threading.current_thread().name

        name = await asyncio.to_thread(work)
        await _wait(lambda: len(entries(r)) == 50, 1.0)
        assert {e["thread"] for e in entries(r)} == {name} != {threading.current_thread().name}
    finally:
        await sink.aclose()


def test_backoff_doubles_from_1_to_30_seconds():
    assert [ls.backoff_delay(n) for n in range(1, 8)] == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0]


async def test_redis_down_keeps_entries_backs_off_and_sends_after_recovery():
    r = FakeRedis()
    r.down = True
    sink = ls.LogSink("collector", r, flush_every_s=0.02, backoff=(0.05, 0.1))
    lg = logger_for(sink)
    sink.start(attach=False)
    try:
        for i in range(3):
            lg.error("db down %s", chr(0x4E00 + i))
        await _wait(lambda: sink.failures >= 2, 2.0)
        assert entries(r) == [] and len(sink.pending()) == 3 and sink.dropped == 0
        r.down = False
        await _wait(lambda: len(entries(r)) == 3, 2.0)
        assert [e["message"] for e in entries(r)] == [f"db down {chr(0x4E00 + i)}" for i in range(3)]  # 순서 유지
        assert sink.failures == 0 and sink.pending() == []
    finally:
        await sink.aclose()


async def test_backoff_holds_even_when_50_entries_arrive():
    r = FakeRedis()
    r.down = True
    sink = ls.LogSink("collector", r, flush_every_s=0.01, backoff=(0.5, 0.5))
    lg = logger_for(sink)
    tries: list[float] = []
    orig = sink.send_pending

    async def counted() -> int:
        tries.append(time.monotonic())
        return await orig()

    sink.send_pending = counted  # type: ignore[method-assign]
    sink.start(attach=False)
    try:
        await _wait(lambda: len(tries) >= 1, 1.0)  # 첫 틱(빈 대기열 — Redis 를 부르지 않고 끝난다)
        lg.warning("first")
        await _wait(lambda: sink.failures == 1, 1.0)
        n = len(tries)
        for i in range(60):
            lg.warning("storm %s", chr(0x4E00 + i))
        await asyncio.sleep(0.25)
        assert len(tries) == n  # 백오프(0.5 s) 동안에는 50건이 모여도 보내지 않는다
    finally:
        await sink.aclose(drain_s=0.2)


async def test_emit_never_blocks_while_redis_hangs():
    class Hung(FakeRedis):
        def pipeline(self, transaction: bool = False):
            p = super().pipeline(transaction)

            async def execute():
                await asyncio.Event().wait()

            p.execute = execute  # type: ignore[method-assign]
            return p

    sink = ls.LogSink("collector", Hung(), flush_every_s=0.01, send_timeout_s=0.05, backoff=(0.05, 0.05))
    lg = logger_for(sink)
    sink.start(attach=False)
    try:
        await asyncio.sleep(0.05)
        t0 = time.monotonic()
        for i in range(1000):
            lg.error("hang %s", chr(0x4E00 + i))
        assert time.monotonic() - t0 < 0.5
        await _wait(lambda: sink.failures >= 1, 1.0)
        assert len(sink.pending()) == ls.QUEUE_MAX and sink.dropped == 500  # 보내지 못한 것은 대기열에 그대로(상한 안)
    finally:
        await sink.aclose(drain_s=0.1)


# ── 재귀 금지 · 오류 ────────────────────────────────────────────


async def test_the_sinks_own_warnings_and_logs_raised_while_sending_are_not_queued(caplog):
    class Chatty(FakeRedis):
        async def xadd(self, stream, fields, **kw):
            logging.getLogger("redis.fake").warning("inside the send path")  # 보내는 중에 라이브러리가 남긴 로그
            return await super().xadd(stream, fields, **kw)

    r = Chatty()
    sink = ls.LogSink("collector", r, flush_every_s=0.02, backoff=(0.05, 0.05))
    root = logging.getLogger()
    root.addHandler(sink)
    sink.start(attach=False)
    try:
        r.down = True
        logging.getLogger("test.recursion").error("real problem")
        await _wait(lambda: sink.failures >= 1, 1.0)
        r.down = False
        await _wait(lambda: len(entries(r)) >= 1, 1.0)
        await asyncio.sleep(0.1)
    finally:
        root.removeHandler(sink)
        await sink.aclose()
    assert [e["logger"] for e in entries(r)] == ["test.recursion"]
    assert any(rec.name == "logsink" for rec in caplog.records)  # 싱크 자신의 오류는 표준 출력(로그 핸들러)에만


def test_a_record_that_cannot_be_built_is_dropped_and_counted_not_raised(capsys):
    class Bad:
        def __str__(self) -> str:
            raise RuntimeError("no str")

    sink = ls.LogSink("collector", FakeRedis(), clock=Clock())
    sink.emit(logging.LogRecord("x", logging.ERROR, __file__, 1, Bad(), None, None))
    assert sink.dropped == 1 and sink.pending() == []
    assert "logsink" in capsys.readouterr().err


# ── 설치 · 해제 · 설정 ───────────────────────────────────────────


async def test_start_attaches_to_the_root_logger_and_aclose_flushes_and_detaches():
    r = FakeRedis()
    root = logging.getLogger()
    sink = ls.start_log_sink("collector", r, enabled=True)
    assert sink is not None
    try:
        assert sink in root.handlers and any(isinstance(f, masking.MaskFilter) for f in sink.filters)
        again = ls.start_log_sink("collector", r, enabled=True)  # 다시 불러도 싱크가 쌓이지 않는다(시험에서 main 반복)
        assert again is not None and sink not in root.handlers and again in root.handlers
        await sink.aclose()
        sink = again
        logging.getLogger("test.attach").warning("before close")
    finally:
        await sink.aclose()
    assert not any(isinstance(h, ls.LogSink) for h in root.handlers)
    assert [e["message"] for e in entries(r)] == ["before close"]  # 닫을 때 남은 것을 보낸다


async def test_disabled_sink_is_not_attached_and_reports_unknown_counts():
    root = logging.getLogger()
    before = list(root.handlers)
    assert ls.start_log_sink("collector", FakeRedis(), enabled=False) is None
    assert root.handlers == before
    assert ls.sink_metrics(None) == {"log_sent": "", "log_dropped": "", "log_suppressed": ""}  # 재지 않은 값은 0 이 아니라 모름
    await ls.close_log_sink(None)


def test_log_sink_enabled_setting_defaults_on_and_reads_env(monkeypatch):
    from wakeline_collector.ais.config import AisSettings
    from wakeline_collector.config import Settings

    monkeypatch.delenv("LOG_SINK_ENABLED", raising=False)
    assert Settings().log_sink_enabled is True and AisSettings().log_sink_enabled is True
    monkeypatch.setenv("LOG_SINK_ENABLED", "0")
    assert Settings().log_sink_enabled is False and AisSettings().log_sink_enabled is False


async def test_context_names_the_asyncio_task_and_stays_within_limits():
    sink = ls.LogSink("collector", FakeRedis(), clock=Clock())
    lg = logger_for(sink)

    async def job() -> None:
        lg.warning("inside a job")

    await asyncio.create_task(job(), name="job:region")
    ((js, _n),) = sink.pending()
    ctx = orjson.loads(js)["context"]
    assert ctx["task"] == "job:region"
    assert len(ctx) <= 20 and all(not isinstance(v, str) or len(v) <= 200 for v in ctx.values())


async def _wait(pred, timeout: float) -> None:
    end = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)
