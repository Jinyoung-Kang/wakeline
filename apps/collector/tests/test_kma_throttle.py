"""기상청 API허브 HTTP 429(운영 로그 2026-09-30 KST 10:55:56 · 11:26:16 · 13:01:59 · 13:22:09): '현재 요청을 처리할 수 없습니다. 잠시 후 다시
시도해주십시오.' — 모두 같은 주기의 앞선 KMA 요청 0.1–0.5 s 뒤(예: 11:26:16.439 'still unavailable' → 11:26:16.558 429).
고치기 전: apihub.kma.go.kr 에는 호스트 버킷이 없어 수집기 전체 버킷(2 req/s · burst 2)만 지났다 — 목록 · 바이너리 · 다시 받기가 거의 붙어서 나갔다.
'파일 없음' 연속(계약 v5 §G22)이 닫히면 보관 창의 빈 tm(최대 MAX_PER_CYCLE 개)을 한 주기에 이어 받는다 — 그 묶음도 붙어서 나갔다.
429 는 실행 기록 'error' · 공급자 last_error(공급자 오류)로 남았다 — 계약의 실행 상태 'throttled'(속도 상한)가 있는데도.
이 파일의 시험은 고치기 전 코드에서 실패했다(호스트 버킷 없음 · default_limiter 에 kma_rps 없음 · 상태 'error').
외부 호출은 없다(respx).
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import respx

from wakeline_collector.http import HttpClient
from wakeline_collector.providers.kma_radar import FILE_URL, LIST_URL, KmaRadarProvider
from wakeline_collector.ratelimit import RateLimiter, default_limiter

KMA_HOST = "apihub.kma.go.kr"
BODY_429 = "현재 요청을 처리할 수 없습니다. 잠시 후 다시 시도해주십시오."


class _Hdr:
    def __init__(self, tm: str):
        self.tm = datetime.strptime(tm, "%Y%m%d%H%M")
        self.product = "HSR"
        self.stations = ["KWK"]


def _gz_decode(raw: bytes):
    """가짜 gzip(매직 + tm) → 헤더 · PNG · meta(시험용 — 격자 해석 없이 작업 흐름만 본다)."""
    tm = raw[2:].decode()
    meta = {
        "coordinates": [[0, 1], [1, 1], [1, 0], [0, 0]],
        "width": 1,
        "height": 1,
        "projection": "lcc",
        "grid": {},
        "legend": [],
        "min_dbz": 5.0,
        "observed_cells": 1,
        "echo_cells": 0,
    }
    return _Hdr(tm[:12]), b"PNG" + raw, meta


def _tms(until: str, since: str = "202609271000") -> list[str]:
    day = [f"20260927{h:02d}{m:02d}" for h in range(0, 24) for m in range(0, 60, 5)]
    return [t for t in day if since <= t <= until]


class KmaServer:
    """respx 로 흉내 낸 기상청: 목록은 시계까지의 tm(EXT), 내려받기는 down 이면 '# file not exist', 아니면 gzip 매직 + tm.
    status_for(tm) 가 (상태, 헤더)를 돌려주면 그 답(429 등). 요청마다 (단조 시각, 종류, tm)를 남긴다."""

    def __init__(self, clock: dict):
        self.clock = clock
        self.down: set[str] = set()
        self.reject: dict[str, tuple[int, dict[str, str]]] = {}
        self.calls: list[tuple[float, str, str]] = []

    def listing(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((time.monotonic(), "list", request.url.params["tm"]))
        body = "".join(f"RDR_CMP_HSR_EXT_{t}.bin.gz,=\n" for t in _tms(self.clock["now"]))
        return httpx.Response(200, content=body.encode())

    def binary(self, request: httpx.Request) -> httpx.Response:
        tm = request.url.params["tm"]
        self.calls.append((time.monotonic(), "bin", tm))
        if tm in self.reject:
            status, headers = self.reject[tm]
            return httpx.Response(status, headers=headers, content=BODY_429.encode("utf-8"))
        if tm in self.down:
            return httpx.Response(200, content=f"# file not exist (RDR_CMP_HSR_PUB_{tm}.bin.gz)".encode())
        return httpx.Response(200, content=b"\x1f\x8b" + tm.encode())


@pytest.fixture
def kma(monkeypatch):
    from fakes import FakeRedis, make_ctx

    from wakeline_collector.jobs import kma_radar as mod

    monkeypatch.setattr(mod, "_decode", _gz_decode)
    clock = {"now": "202609271100"}
    wall = lambda: datetime.strptime(clock["now"], "%Y%m%d%H%M")  # noqa: E731
    monkeypatch.setattr(mod, "kst_now", wall)
    monkeypatch.setattr(mod, "_now", lambda: (wall() - timedelta(hours=9)).replace(tzinfo=UTC))

    async def no_sleep(_s):  # 일시 오류 다시 부르기의 5 s — 이 파일은 429 · 속도 상한만 본다
        return None

    monkeypatch.setattr(mod, "_sleep", no_sleep)
    r = FakeRedis()
    ctx = make_ctx(r, limits={"kma_radar": 1000})
    runs: list[dict] = []
    real = ctx.db.record_run

    def rec(job, provider, started_at, **kw):
        runs.append(kw)
        real(job, provider, started_at, **kw)

    ctx.db.record_run = rec
    return mod, r, ctx, clock, runs


def _gaps(calls: list[tuple[float, str, str]]) -> list[float]:
    return [b[0] - a[0] for a, b in zip(calls, calls[1:], strict=False)]


# ---- 호스트 버킷 -----------------------------------------------------------------------------------------------------------
def test_default_limiter_has_a_kma_apihub_bucket():
    """고른 값(ADR-011 개정 2026-09-30): apihub.kma.go.kr 0.5 req/s · burst 1 — 기상청은 초당 한도를 밝히지 않았고(우리가 확인한 문서 없음)
    429 는 앞선 요청 0.1–0.5 s 뒤에 났다. 2 s 간격은 그 가장 긴 간격(0.5 s)의 4배다. 수집기 전체 버킷은 그대로."""
    from wakeline_collector.config import Settings

    lim = default_limiter(2.0, 0.8)
    assert lim.host_rps(KMA_HOST) == 0.5 and lim._hosts[KMA_HOST].burst == 1
    assert lim.global_rps == 2.0 and lim.host_rps("opendata.adsb.fi") == 0.8
    assert Settings().kma_apihub_rps == 0.5
    assert HttpClient().limiter.host_rps(KMA_HOST) == 0.5  # 운영 클라이언트가 설정을 쓴다


async def test_recovery_backlog_is_paced_by_the_kma_host_bucket(kma):
    """'파일 없음' 연속이 닫힌 다음 주기: 보관 창의 빈 tm 을 MAX_PER_CYCLE 개까지 이어 받는다. 요청 사이 간격은 호스트 버킷(1/rate)보다 짧지 않다.
    속도는 시험 시간을 줄이려고 20 req/s(50 ms)로 둔다 — 운영 값(0.5 req/s = 2 s)과 같은 경로(default_limiter)를 지난다."""
    from wakeline_collector.jobs.kma_radar import MAX_PER_CYCLE, MissingStreak

    mod, r, ctx, clock, runs = kma
    rate = 20.0
    http = HttpClient(default_limiter(100.0, 0.8, kma_rps=rate))  # 전체 버킷은 넉넉히 — 간격은 기상청 호스트 버킷이 만든다
    server = KmaServer(clock)
    job = mod.KmaRadarJob(KmaRadarProvider(http, "k" * 12), ctx)
    at = datetime(2026, 9, 27, 1, 30, tzinfo=UTC)
    job.missing = MissingStreak("202609271030", "202609271100", 7, at, at)  # 10:30 부터 '파일 없음' — 11:00 에 회복
    job._loaded = True
    with respx.mock:
        respx.get(LIST_URL).mock(side_effect=server.listing)
        respx.get(FILE_URL).mock(side_effect=server.binary)
        await job.run_once()  # 확인 두 tm 이 gzip — 연속을 닫는다
        assert job.missing is None
        clock["now"] = "202609271105"
        server.calls.clear()
        await job.run_once()  # 회복 뒤 첫 주기: 보관 창의 빈 곳을 이어 받는다
    await http.aclose()
    bins = [c for c in server.calls if c[1] == "bin"]
    assert len(bins) == MAX_PER_CYCLE  # 이어 받은 묶음
    gaps = _gaps(server.calls)  # 목록 → 바이너리 → … 모든 KMA 요청 사이
    assert min(gaps) >= 0.9 / rate, gaps
    assert runs[-1]["status"] == "ok" and runs[-1]["records_in"] == MAX_PER_CYCLE


async def test_without_the_host_bucket_the_backlog_went_out_back_to_back(kma):
    """고치기 전과 같은 한도(전체 2 req/s · burst 2 · 호스트 버킷 없음): 같은 묶음의 첫 요청 사이는 0.5 s 보다 짧다 — 429 가 난 간격(0.1–0.5 s)."""
    mod, r, ctx, clock, runs = kma
    http = HttpClient(RateLimiter(2.0, 2))
    server = KmaServer(clock)
    job = mod.KmaRadarJob(KmaRadarProvider(http, "k" * 12), ctx)
    with respx.mock:
        respx.get(LIST_URL).mock(side_effect=server.listing)
        respx.get(FILE_URL).mock(side_effect=server.binary)
        await job.run_once()
    await http.aclose()
    assert min(_gaps(server.calls)) < 0.5


# ---- 429: 호스트를 멈추고(Retry-After) 실행은 'throttled' ------------------------------------------------------------------------
async def test_kma_429_pauses_the_host_honouring_retry_after_and_records_a_throttled_run(kma, caplog):
    mod, r, ctx, clock, runs = kma
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    http = HttpClient(default_limiter(100.0, 0.8, kma_rps=50.0))
    server = KmaServer(clock)
    tms = _tms("202609271100")
    server.reject[tms[-3]] = (429, {"Retry-After": "120"})  # 두 번째 바이너리에서 429
    job = mod.KmaRadarJob(KmaRadarProvider(http, "k" * 12), ctx)
    with respx.mock:
        respx.get(LIST_URL).mock(side_effect=server.listing)
        respx.get(FILE_URL).mock(side_effect=server.binary)
        await job.run_once()
    assert [c[2] for c in server.calls if c[1] == "bin"] == [tms[-4], tms[-3]]  # 429 뒤로는 이 주기에 KMA 를 부르지 않는다
    assert http.limiter.cooldown_remaining(KMA_HOST) >= 110  # Retry-After 120 s 를 따른다(모든 호출자 공통)
    assert len(runs) == 1
    run = runs[0]
    assert run["status"] == "throttled" and run["http_status"] == 429 and run["records_in"] == 1
    assert "HTTP 429" in run["error_text"] and f"binary tm={tms[-3]}" in run["error_text"] and "120 s" in run["error_text"]
    h = await r.hgetall("wakeline:provider:kma_radar")
    assert "last_error" not in h and h.get("consecutive_failures", "0") == "0"  # 공급자 오류가 아니다(계약 v5 §G14 — 'error' 만)
    warns = [x.getMessage() for x in caplog.records if x.name == "job.kma_radar" and x.levelno >= logging.WARNING]
    assert len(warns) == 1 and "HTTP 429" in warns[0] and "paused 120 s" in warns[0] and "Retry-After 120 s" in warns[0]
    await http.aclose()


async def test_kma_429_without_retry_after_uses_the_step_backoff(kma):
    mod, r, ctx, clock, runs = kma
    http = HttpClient(default_limiter(100.0, 0.8, kma_rps=50.0))
    server = KmaServer(clock)
    server.reject[_tms("202609271100")[-4]] = (429, {})
    with respx.mock:
        respx.get(LIST_URL).mock(side_effect=server.listing)
        respx.get(FILE_URL).mock(side_effect=server.binary)
        await mod.KmaRadarJob(KmaRadarProvider(http, "k" * 12), ctx).run_once()
    assert 25 <= http.limiter.cooldown_remaining(KMA_HOST) <= 30  # 첫 429 — 단계 30 s(ratelimit.PENALTY_STEPS_S)
    assert runs[0]["status"] == "throttled" and "no Retry-After" in runs[0]["error_text"]
    await http.aclose()


async def test_next_cycle_inside_the_pause_is_not_sent_and_is_throttled_too(kma, caplog):
    """429 의 쉼(Retry-After 600)이 다음 주기(5분)보다 길면 다음 주기의 목록은 보내지 않는다(속도 상한 Throttled) — 실행 'throttled',
    예산은 돌려주고, 이미 WARN 한 429 의 결과라 INFO 한 줄."""
    mod, r, ctx, clock, runs = kma
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    http = HttpClient(default_limiter(100.0, 0.8, kma_rps=50.0))
    server = KmaServer(clock)
    server.reject[_tms("202609271100")[-4]] = (429, {"Retry-After": "600"})
    job = mod.KmaRadarJob(KmaRadarProvider(http, "k" * 12), ctx)
    with respx.mock:
        respx.get(LIST_URL).mock(side_effect=server.listing)
        respx.get(FILE_URL).mock(side_effect=server.binary)
        await job.run_once()
        used = (await ctx.budget.usage("kma_radar"))[0]
        n = len(server.calls)
        caplog.clear()
        clock["now"] = "202609271105"
        await job.run_once()
    assert len(server.calls) == n  # 보내지 않았다
    assert [x["status"] for x in runs] == ["throttled", "throttled"] and runs[1].get("http_status") is None
    assert "cooling down" in runs[1]["error_text"]
    assert (await ctx.budget.usage("kma_radar"))[0] == used  # 보내지 않은 목록 호출은 예산을 돌려준다
    msgs = [(x.levelno, x.getMessage()) for x in caplog.records if x.name == "job.kma_radar"]
    assert [lv for lv, _m in msgs if lv >= logging.WARNING] == [] and any("not called" in m for _lv, m in msgs)
    await http.aclose()
