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
import orjson
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
async def test_default_limiter_has_a_kma_apihub_bucket():
    """고른 값(ADR-011 개정 2026-09-30): apihub.kma.go.kr 0.5 req/s · burst 1 — 기상청은 초당 한도를 밝히지 않았고(우리가 확인한 문서 없음)
    429 는 앞선 요청 0.1–0.5 s 뒤에 났다. 2 s 간격은 그 가장 긴 간격(0.5 s)의 4배다. 수집기 전체 버킷은 그대로."""
    from wakeline_collector.config import Settings

    lim = default_limiter(2.0, 0.8)
    assert lim.host_rps(KMA_HOST) == 0.5 and lim._hosts[KMA_HOST].burst == 1
    assert lim.global_rps == 2.0 and lim.host_rps("opendata.adsb.fi") == 0.8
    assert Settings().kma_apihub_rps == 0.5
    http = HttpClient()
    assert http.limiter.host_rps(KMA_HOST) == 0.5  # 기본값 — 설정을 바꾼 경우는 아래 시험
    await http.aclose()


async def test_the_running_collector_builds_its_limiter_from_the_kma_setting(monkeypatch):
    """설정 kma_apihub_rps 를 바꾸면 main() 이 만드는 운영 속도 상한에 그대로 걸린다(리뷰 2026-09-30: main.py 가 이 설정을 넘기지 않아
    KMA_APIHUB_RPS 를 바꿔도 늘 0.5 였다 — 고치기 전 이 시험은 0.5 로 실패했다). HttpClient() 의 기본 상한도 같은 함수로 만든다."""
    from wakeline_collector import http as http_mod
    from wakeline_collector import main as col_main

    class Built(Exception):
        pass

    seen: dict = {}

    def spy(limiter=None):
        seen["limiter"] = limiter
        raise Built  # 속도 상한을 만든 곳에서 멈춘다(작업을 띄우지 않는다)

    class NoDb:
        def start(self) -> None:
            return None

    tuned = col_main.settings.model_copy(update={"kma_apihub_rps": 0.25, "data_go_kr_rps": 0.75, "adsbdb_rps": 0.4})
    monkeypatch.setattr(col_main, "settings", tuned)
    monkeypatch.setattr(col_main, "configure_logging", lambda *_a, **_k: None)
    monkeypatch.setattr(col_main, "HttpClient", spy)
    with pytest.raises(Built):
        await col_main.main(stop=None, redis=object(), db=NoDb())
    lim = seen["limiter"]
    assert lim.host_rps(KMA_HOST) == 0.25
    assert lim.host_rps("apis.data.go.kr") == 0.75 and lim.host_rps("api.adsbdb.com") == 0.4
    assert lim.global_rps == tuned.http_global_rps and lim.host_rps("opendata.adsb.fi") == tuned.adsb_fi_rps
    monkeypatch.setattr(http_mod, "settings", tuned)
    client = http_mod.HttpClient()
    assert client.limiter.host_rps(KMA_HOST) == 0.25
    await client.aclose()


async def test_recovery_backlog_is_paced_by_the_kma_host_bucket(kma):
    """'파일 없음' 연속이 닫힌 다음 주기: 보관 창의 빈 tm 을 MAX_PER_CYCLE 개까지 이어 받는다. 요청 사이 간격은 호스트 버킷(1/rate)보다 짧지 않다.
    속도는 시험 시간을 줄이려고 10 req/s(100 ms)로 둔다 — 운영 값(0.5 req/s = 2 s)과 같은 경로(default_limiter)를 지난다. 버킷은 허가 사이를 벌린다 —
    허가에서 보내기까지의 지연이 요청마다 조금 달라 보낸 시각 사이는 20 % 여유를 둔다(버킷 없을 때는 몇 ms)."""
    from wakeline_collector.jobs.kma_radar import MAX_PER_CYCLE, MissingStreak

    mod, r, ctx, clock, runs = kma
    rate = 10.0
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
    assert min(gaps) >= 0.8 / rate, gaps
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


async def test_kma_429_mid_cycle_keeps_what_the_cycle_already_did(kma):
    """429 로 주기가 중간에 멈춰도 그 주기가 이미 한 일은 남긴다(리뷰 2026-09-30 — 고치기 전에는 곧바로 return 해서 잃었다):
    이미 포기한 tm 의 품질 이벤트(kma_radar_missing — _mark_bad 로 다시 받지 않으니 영영 잃었다) · 그 주기에 연 '파일 없음' 연속의 발행
    (Retry-After 가 길면 다음 주기도 멈춰 10분까지 화면에 없었다) · heartbeat. 실행은 'throttled'(http 429) 그대로."""
    mod, r, ctx, clock, runs = kma
    http = HttpClient(default_limiter(100.0, 0.8, kma_rps=50.0))
    server = KmaServer(clock)
    tms = _tms("202609271100")
    server.down.add(tms[-4])  # 10:45 — 이번이 세 번째 '파일 없음' → 포기(품질 이벤트) · 더 새 파일이 없어 연속을 연다
    server.reject[tms[-3]] = (429, {"Retry-After": "120"})
    job = mod.KmaRadarJob(KmaRadarProvider(http, "k" * 12), ctx)
    job._not_ready[tms[-4]] = mod.MAX_NOT_READY_TRIES - 1
    with respx.mock:
        respx.get(LIST_URL).mock(side_effect=server.listing)
        respx.get(FILE_URL).mock(side_effect=server.binary)
        await job.run_once()
    await http.aclose()
    assert [c[2] for c in server.calls if c[1] == "bin"] == [tms[-4], tms[-3]]
    assert len(runs) == 1
    run = runs[0]
    assert run["status"] == "throttled" and run["http_status"] == 429 and run["records_in"] == 0
    assert [q[0] for q in run["quality"]] == ["kma_radar_missing"] and run["quality"][0][2]["tm"] == tms[-4]
    assert run["records_quarantined"] == 1
    assert "HTTP 429" in run["error_text"] and f"tm={tms[-4]}" in run["error_text"]  # 429 와 그 주기의 '파일 없음' 까닭 둘 다
    meta = await r.hgetall(mod.KEY_META)
    assert job.missing is not None and meta.get("missing_since_tm") == tms[-4]  # 연 연속을 같은 주기에 싣는다
    assert (await r.hgetall("wakeline:collector")).get("radar_kr_at")  # heartbeat
    h = await r.hgetall("wakeline:provider:kma_radar")
    assert "last_success_at" not in h and "last_error" not in h  # 저장한 프레임 없음 — 성공이 아니다 · 공급자 오류도 아니다


async def test_kma_429_after_a_stored_frame_still_records_the_provider_success(kma):
    """프레임 하나를 저장한 뒤 429: 실행은 'throttled' 지만 공급자는 그 프레임을 내줬다 — last_success_at · last_records 를 적는다(리뷰 2026-09-30)."""
    mod, r, ctx, clock, runs = kma
    http = HttpClient(default_limiter(100.0, 0.8, kma_rps=50.0))
    server = KmaServer(clock)
    tms = _tms("202609271100")
    server.reject[tms[-3]] = (429, {"Retry-After": "120"})
    with respx.mock:
        respx.get(LIST_URL).mock(side_effect=server.listing)
        respx.get(FILE_URL).mock(side_effect=server.binary)
        await mod.KmaRadarJob(KmaRadarProvider(http, "k" * 12), ctx).run_once()
    await http.aclose()
    assert runs[0]["status"] == "throttled" and runs[0]["records_in"] == 1
    h = await r.hgetall("wakeline:provider:kma_radar")
    assert h.get("last_success_at") and h.get("last_records") == "1" and "last_error" not in h


def _stored_partial_frames(mod, tms: list[str]) -> list[dict]:
    """보관 창을 모두 채운 12 프레임 — 가장 새 두 tm 이 부분 합성(다시 받기 대상: 10분 전에 받음 > 간격 4분)."""
    fetched = (datetime(2026, 9, 27, 2, 0, tzinfo=UTC) - timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
    exp = (datetime.now(UTC) + timedelta(hours=2)).isoformat().replace("+00:00", "Z")
    return [{"tm": t, "fetched_at": fetched, "expires_at": exp, "stations": 5, "partial": t >= tms[-2]} for t in tms]


async def test_kma_429_on_the_partial_frame_refetch_is_a_throttled_run_with_one_warning(kma, caplog):
    """다시 받기(ADR-021) 중 429: 고치기 전에는 INFO 한 줄로 삼키고 실행을 'ok'(http 200)로 남겼다 — 로그 화면(WARN 이상)에도, 실행 표에도 보이지
    않았다(리뷰 2026-09-30 · 운영 로그 11:26:16 의 모양: 'still unavailable' 직후 429). 고친 뒤: WARN 한 줄(쉰 초 · Retry-After) · 남은 다시 받기를
    멈춘다 · 정규 부분이 'ok' 면 실행은 'throttled'(http 429). 목록은 답했으니 공급자 성공은 그대로 적는다."""
    mod, r, ctx, clock, runs = kma
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    tms = _tms("202609271100")[-12:]
    await r.set(mod.KEY_FRAMES, orjson.dumps(_stored_partial_frames(mod, tms)).decode())
    for t in tms:
        await r.set(mod.KEY_FRAME.format(tm=t), "x")
    http = HttpClient(default_limiter(100.0, 0.8, kma_rps=50.0))
    server = KmaServer(clock)
    for t in tms[-2:]:
        server.reject[t] = (429, {"Retry-After": "120"})
    job = mod.KmaRadarJob(KmaRadarProvider(http, "k" * 12), ctx)
    job._loaded = True
    with respx.mock:
        respx.get(LIST_URL).mock(side_effect=server.listing)
        respx.get(FILE_URL).mock(side_effect=server.binary)
        await job.run_once()
    await http.aclose()
    assert [(c[1], c[2]) for c in server.calls] == [("list", "20260927"), ("bin", tms[-2])]
    assert job.refetch_attempts == 1  # 429 뒤로는 다시 받기를 시도하지 않는다(쉼 안의 호출을 줄 세우지 않는다)
    assert len(runs) == 1
    run = runs[0]
    assert run["status"] == "throttled" and run["http_status"] == 429 and run["records_in"] == 0
    assert (
        f"refetch tm={tms[-2]}" in run["error_text"] and "HTTP 429" in run["error_text"] and "paused 120 s" in run["error_text"]
    )
    warns = [x.getMessage() for x in caplog.records if x.name == "job.kma_radar" and x.levelno >= logging.WARNING]
    assert len(warns) == 1 and f"refetch tm={tms[-2]}" in warns[0] and "HTTP 429" in warns[0] and "Retry-After 120 s" in warns[0]
    h = await r.hgetall("wakeline:provider:kma_radar")
    assert h.get("last_success_at") and "last_error" not in h
    assert (await r.hgetall("wakeline:collector")).get("radar_kr_refetches") == "1"


async def test_kma_429_on_the_refetch_after_a_missing_cycle_keeps_the_missing_status_and_names_the_429(kma):
    """정규 부분이 'ok' 가 아니면(새 tm 이 '파일 없음') 그 상태가 주기의 답이다 — 다시 받기 429 는 오류 글자에 덧붙인다(버리지 않는다)."""
    mod, r, ctx, clock, runs = kma
    tms = _tms("202609271100")[-12:]
    await r.set(mod.KEY_FRAMES, orjson.dumps(_stored_partial_frames(mod, tms[:-1])).decode())
    for t in tms[:-1]:
        await r.set(mod.KEY_FRAME.format(tm=t), "x")
    http = HttpClient(default_limiter(100.0, 0.8, kma_rps=50.0))
    server = KmaServer(clock)
    server.down.add(tms[-1])
    server.reject[tms[-3]] = (429, {"Retry-After": "120"})  # 부분 합성(tms[-3] 는 이 목록에서 뒤에서 둘째)
    job = mod.KmaRadarJob(KmaRadarProvider(http, "k" * 12), ctx)
    job._loaded = True
    with respx.mock:
        respx.get(LIST_URL).mock(side_effect=server.listing)
        respx.get(FILE_URL).mock(side_effect=server.binary)
        await job.run_once()
    await http.aclose()
    run = runs[0]
    assert run["status"] == "missing" and run["http_status"] == 200
    assert run["error_text"].startswith("no new frame stored") and f"refetch tm={tms[-3]}" in run["error_text"]
    assert "HTTP 429" in run["error_text"]
