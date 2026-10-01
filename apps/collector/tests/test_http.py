"""외부 호출 클라이언트: 허용 호스트·https·크기 상한·속도 상한·429 쿨다운. 실제 네트워크는 쓰지 않는다(respx)."""

from __future__ import annotations

import gzip
import tracemalloc
import zlib

import httpx
import pytest
import respx

from wakeline_collector import http as httpmod
from wakeline_collector.http import HostNotAllowed, HttpClient, ProviderHttpError, ResponseTooLarge
from wakeline_collector.ratelimit import PRIORITY_HOT, RateLimiter, Throttled


def _client(**hosts: tuple[float, float]) -> HttpClient:
    return HttpClient(RateLimiter(100, 100, {h.replace("_", "."): v for h, v in hosts.items()}))


async def test_disallowed_host_and_plain_http_are_refused_before_any_call():
    c = _client()
    with respx.mock(assert_all_called=False) as m:
        route = m.get(url__regex=r".*").mock(return_value=httpx.Response(200))
        with pytest.raises(HostNotAllowed):
            await c.get("https://evil.example/x")
        with pytest.raises(HostNotAllowed):
            await c.get("http://api.adsb.lol/v2/point/1/2/3")
        assert route.call_count == 0 and c.limiter.granted == 0
    await c.aclose()


async def test_adsbdb_is_an_allowed_host_with_its_own_bucket():
    """계약 v4 §A: 노선 조회 호스트. 기본 속도 상한(HttpClient 기본 limiter)에 호스트 버킷이 있다."""
    assert "api.adsbdb.com" in httpmod.ALLOWED_HOSTS
    c = HttpClient()
    assert c.limiter.host_rps("api.adsbdb.com") == 0.5
    with respx.mock:
        respx.get("https://api.adsbdb.com/v0/callsign/ZZX123").mock(
            return_value=httpx.Response(404, json={"response": "unknown callsign"})
        )
        with pytest.raises(ProviderHttpError) as ei:
            await c.get("https://api.adsbdb.com/v0/callsign/ZZX123")
    assert ei.value.status == 404 and ei.value.body_head == '{"response":"unknown callsign"}' and ei.value.latency_ms is not None
    await c.aclose()


async def test_success_goes_through_limiter():
    c = _client()
    with respx.mock:
        respx.get("https://api.adsb.lol/v2/point/1/2/3").mock(return_value=httpx.Response(200, json={"ac": []}))
        r = await c.get("https://api.adsb.lol/v2/point/1/2/3")
    assert r.status == 200 and r.body == b'{"ac":[]}' and c.limiter.granted == 1
    await c.aclose()


async def test_429_penalizes_host_with_retry_after():
    c = _client(opendata_adsb_fi=(100.0, 5))
    with respx.mock:
        respx.get("https://opendata.adsb.fi/api/v2/icao/abcdef").mock(
            return_value=httpx.Response(429, headers={"Retry-After": "90"}, text="slow down")
        )
        with pytest.raises(ProviderHttpError) as ei:
            await c.get("https://opendata.adsb.fi/api/v2/icao/abcdef")
    assert ei.value.status == 429 and "slow down" in str(ei.value)
    assert c.limiter.cooldown_remaining("opendata.adsb.fi") > 80
    with pytest.raises(Throttled):  # 이후 호출은 보내지 않는다(모든 호출자 공통)
        await c.get("https://opendata.adsb.fi/api/v2/icao/abcdef", priority=PRIORITY_HOT, wait_s=1)
    await c.aclose()


async def test_http_error_without_penalty_and_retry_after_parse():
    assert httpmod._retry_after_s({"retry-after": "12"}) == 12.0
    assert httpmod._retry_after_s({}) is None
    c = _client()
    with respx.mock:
        respx.get("https://aviationweather.gov/api/data/x").mock(return_value=httpx.Response(503, text="down"))
        with pytest.raises(ProviderHttpError) as ei:
            await c.get("https://aviationweather.gov/api/data/x")
    assert ei.value.status == 503 and c.limiter.cooldown_remaining("aviationweather.gov") == 0
    await c.aclose()


def test_retry_after_http_date_is_honoured():
    """RFC 9110 §10.2.3: Retry-After 는 초(delay-seconds) 또는 HTTP-date. 고치기 전에는 날짜 모양을 버리고 단계 백오프(30 s …)만 썼다
    (기상청 429 대응 — 2026-09-30). 지난 날짜 · 틀린 모양은 None(단계 백오프)."""
    from datetime import UTC, datetime

    now = datetime(2026, 10, 21, 7, 26, 0, tzinfo=UTC)
    assert httpmod._retry_after_s({"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"}, now=now) == 120.0
    assert httpmod._retry_after_s({"retry-after": "Wed, 21 Oct 2026 07:20:00 GMT"}, now=now) is None  # 지난 시각
    assert httpmod._retry_after_s({"retry-after": "soon"}, now=now) is None
    assert httpmod._retry_after_s({"retry-after": "-5"}, now=now) is None


async def test_429_with_an_http_date_retry_after_pauses_the_host_until_then(monkeypatch):
    from datetime import UTC, datetime, timedelta
    from email.utils import format_datetime

    c = _client(apihub_kma_go_kr=(100.0, 5))
    until = format_datetime(datetime.now(UTC) + timedelta(seconds=200), usegmt=True)
    with respx.mock:
        respx.get("https://apihub.kma.go.kr/api/typ01/url/x").mock(
            return_value=httpx.Response(429, headers={"Retry-After": until})
        )
        with pytest.raises(ProviderHttpError) as ei:
            await c.get("https://apihub.kma.go.kr/api/typ01/url/x")
    assert 190 <= c.limiter.cooldown_remaining("apihub.kma.go.kr") <= 200
    assert ei.value.pause_s is not None and 190 <= ei.value.pause_s <= 200  # 호출자가 로그 · 실행 기록에 적는 쉼
    await c.aclose()


async def test_response_size_cap(monkeypatch):
    monkeypatch.setattr(httpmod.settings, "http_max_bytes", 10)
    c = _client()
    with respx.mock:
        respx.get("https://api.rainviewer.com/public/weather-maps.json").mock(
            return_value=httpx.Response(200, content=b"x" * 100)
        )
        with pytest.raises(ResponseTooLarge):
            await c.get("https://api.rainviewer.com/public/weather-maps.json")
    await c.aclose()


class _Trickle(httpx.AsyncByteStream):
    """8 s 읽기 시간 초과에 걸리지 않을 만큼 조금씩 끝없이 보내는 응답(리뷰 R-67 조건)."""

    async def __aiter__(self):
        import asyncio

        while True:
            yield b"x"
            await asyncio.sleep(0.05)


async def test_r67_whole_request_has_a_total_time_limit_and_counts_as_sent():
    """리뷰 R-67: httpx 시간 초과는 읽기 한 번마다라서, 조금씩 계속 보내는 공급자에 호출 하나가 몇 분씩 걸릴 수 있었다."""
    import asyncio
    import time

    c = _client()
    with respx.mock:
        respx.get("https://api.rainviewer.com/public/weather-maps.json").mock(return_value=httpx.Response(200, stream=_Trickle()))
        t0 = time.monotonic()
        with pytest.raises(httpmod.RequestTimedOut) as e:
            await asyncio.wait_for(c.get("https://api.rainviewer.com/public/weather-maps.json", total_s=0.5), 5)
    assert time.monotonic() - t0 < 2.0
    assert not isinstance(e.value, httpmod.NOT_SENT_ERRORS)  # 보낸 호출로 센다(예산을 되돌리지 않는다)
    assert isinstance(e.value, httpx.TimeoutException)  # 기존 오류 처리(httpx.HTTPError)를 그대로 탄다
    assert c.limiter.granted == 1
    await c.aclose()


async def test_r67_callers_get_their_own_total_limits():
    from wakeline_collector.providers import kma_radar, readsb

    assert httpmod.DEFAULT_TOTAL_S >= httpmod.settings.http_timeout_s
    assert readsb.REGION_TOTAL_S <= 15 and kma_radar.KMA_TOTAL_S >= 25  # 관심 지역 15 s · KMA 실측 최대 25 s


async def test_post_form_is_limited_too():
    c = _client()
    with respx.mock:
        route = respx.post("https://auth.opensky-network.org/token").mock(return_value=httpx.Response(200, json={}))
        r = await c.post_form("https://auth.opensky-network.org/token", {"grant_type": "client_credentials"})
    assert r.status == 200 and route.call_count == 1 and c.limiter.granted == 1
    await c.aclose()


async def test_default_client_uses_contract_limits():
    c = HttpClient()
    assert c.limiter.global_rps == 2.0 and c.limiter.host_rps("opendata.adsb.fi") == 0.8
    await c.aclose()


async def test_before_send_runs_after_the_rate_limit_grant_and_can_stop_the_call():
    """보내기 직전 확인(계약 v4 G A-2): 속도 상한 허가를 받은 뒤 부르고, False 면 보내지 않는다(SendCancelled — 보내지 않은 실패)."""
    c = _client(api_adsbdb_com=(100, 2))
    order: list[str] = []

    async def no() -> bool:
        order.append(f"check after {c.limiter.granted} grant(s)")
        return False

    async def yes() -> bool:
        return True

    with respx.mock:
        route = respx.get("https://api.adsbdb.com/v0/callsign/ZZX123").mock(return_value=httpx.Response(200, json={}))
        with pytest.raises(httpmod.SendCancelled):
            await c.get("https://api.adsbdb.com/v0/callsign/ZZX123", before_send=no)
        assert route.call_count == 0 and order == ["check after 1 grant(s)"]
        assert (await c.get("https://api.adsbdb.com/v0/callsign/ZZX123", before_send=yes)).status == 200
        assert route.call_count == 1
    assert httpmod.SendCancelled in httpmod.NOT_SENT_ERRORS and httpmod.HostNotAllowed in httpmod.NOT_SENT_ERRORS
    assert httpx.ReadTimeout not in httpmod.NOT_SENT_ERRORS  # 보낸 뒤의 실패는 보낸 것으로 센다
    await c.aclose()


GZ_URL = "https://api.rainviewer.com/public/weather-maps.json"


async def _serving(body: bytes, encoding: str) -> HttpClient:
    """Content-Encoding 이 붙은 본문을 받은 그대로(stream) 주는 클라이언트. respx 는 가짜 응답을 미리 읽어(풀어) 두므로 여기에 맞지 않는다 —
    httpx.MockTransport 로 전송 계층에서 준다."""
    c = _client()
    old = c._client
    c._client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _req: httpx.Response(200, stream=httpx.ByteStream(body), headers={"content-encoding": encoding})
        ),
        headers=old.headers,
        follow_redirects=False,
    )
    await old.aclose()
    return c


def _raw_deflate(data: bytes) -> bytes:
    z = zlib.compressobj(wbits=-zlib.MAX_WBITS)
    return z.compress(data) + z.flush()


@pytest.mark.parametrize(
    ("encoding", "pack"),
    [
        ("gzip", gzip.compress),
        ("deflate", zlib.compress),
        ("deflate", _raw_deflate),
        ("GZIP", gzip.compress),
        ("identity", bytes),
    ],
)
async def test_compressed_bodies_are_decoded_as_before(encoding, pack):
    body = b'{"host":"https://tilecache.rainviewer.com","radar":{}}' * 500
    c = await _serving(pack(body), encoding)
    assert (await c.get(GZ_URL)).body == body
    await c.aclose()


async def test_a_small_compressed_body_that_expands_past_the_cap_is_refused_while_inflating(monkeypatch):
    """보안 검토 L-7(2026-10-01): 크기 상한을 압축을 푼 청크마다 쟀다 — httpx 는 받은 청크(최대 64 KiB)를 한 번에 풀어, 작은 압축 본문 하나가
    수십 MiB 로 다 펼쳐진 뒤에야 ResponseTooLarge 였다(공급자 8 연결이면 수집기 512 MiB 한도까지). 이제 푸는 동안 상한 + 1 바이트에서 멈춘다."""
    cap = 1 << 20
    monkeypatch.setattr(httpmod.settings, "http_max_bytes", cap)
    bomb = gzip.compress(b"\0" * (32 << 20))  # 32 MiB → 약 32 KiB(한 청크)
    assert len(bomb) < 64 << 10
    c = await _serving(bomb, "gzip")
    tracemalloc.start()
    try:
        with pytest.raises(ResponseTooLarge, match="gzip"):
            await c.get(GZ_URL)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 4 * cap, f"peak {peak} B while refusing a body capped at {cap} B"
    await c.aclose()


@pytest.mark.parametrize(
    ("encoding", "body"),
    [("gzip", b"not gzip at all"), ("deflate", b"not deflate"), ("gzip, gzip", gzip.compress(gzip.compress(b"{}")))],
)
async def test_a_corrupt_or_stacked_compressed_body_is_a_decoding_error(encoding, body):
    c = await _serving(body, encoding)
    with pytest.raises(httpx.DecodingError):
        await c.get(GZ_URL)
    await c.aclose()


async def test_the_client_asks_only_for_the_encodings_it_inflates_within_the_cap():
    c = HttpClient()
    assert c._client.headers["accept-encoding"] == "gzip, deflate"
    await c.aclose()


@pytest.mark.parametrize(
    ("error", "outcome"),
    [
        (Throttled("opendata.adsb.fi", "no slot within 4.0 s"), "throttled"),
        (httpx.PoolTimeout("pool full"), "not_sent"),
        (httpx.ProxyError("proxy refused"), "not_sent"),
        (HostNotAllowed("evil.example"), "not_sent"),
        (httpmod.SendCancelled("api.adsb.lol"), "not_sent"),
        (httpx.InvalidURL("bad url"), "not_sent"),
        (httpx.UnsupportedProtocol("ftp"), "not_sent"),
        (httpx.ConnectError("refused"), "failed_before_send"),
        (httpx.ConnectTimeout("connect"), "failed_before_send"),
        (httpx.ReadTimeout("read"), "sent"),
        (httpmod.RequestTimedOut("api.adsb.lol: no complete response within 30 s"), "sent"),
        (ProviderHttpError(503, "down"), "sent"),
        (ValueError("unexpected shape"), "sent"),
    ],
    ids=lambda v: v if isinstance(v, str) else type(v).__name__,
)
def test_one_send_classifier_for_every_job(error, outcome):
    """R-65 · F7(PLAN C3): '보내지 않음' 판정이 작업마다 달랐다(풀 대기 초과를 공급자 실패로 세고 예산을 돌려주지 않았다 · 기상 작업은 속도 상한을
    공급자 실패로 적었다). 한 곳에서 가른다 — throttled · not_sent(우리 쪽 까닭)는 공급자 실패가 아니고, failed_before_send(연결 실패 · 토큰)는
    공급자 실패지만 예산은 돌려준다. sent 만 예산을 쓴다."""
    from wakeline_collector.http import classify_send

    assert classify_send(error) == outcome


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
async def test_a_redirect_is_an_http_error_that_names_only_the_target_host(status):
    """F11(collector-review · PLAN C6): 리다이렉트는 따라가지 않는다(follow_redirects=False — 허용 호스트). 전에는 3xx 를 성공 응답으로 돌려줘 해석기가
    'JSON 아님' · '모양 이상'으로 적었고 운영 last_error 가 까닭(HTTP 302)을 숨겼다. 이제 'HTTP 3xx' 오류 — Location 은 호스트만 싣는다(경로 · 쿼리는 싣지 않는다)."""
    c = _client()
    with respx.mock:
        respx.get(GZ_URL).mock(
            return_value=httpx.Response(
                status, headers={"Location": "https://portal.example/moved/notice?page=FAKE-1"}, text="moved"
            )
        )
        with pytest.raises(ProviderHttpError) as ei:
            await c.get(GZ_URL)
    assert ei.value.status == status and ei.value.body_head == "redirect to portal.example — not followed"
    assert "notice" not in str(ei.value) and "FAKE-1" not in str(ei.value)
    await c.aclose()


async def test_a_redirect_without_a_location_says_so():
    c = _client()
    with respx.mock:
        respx.get(GZ_URL).mock(return_value=httpx.Response(302))
        with pytest.raises(ProviderHttpError) as ei:
            await c.get(GZ_URL)
    assert ei.value.body_head == "redirect to (no Location) — not followed"
    from wakeline_collector.errors import describe_error

    assert describe_error(ei.value) == "HTTP 302 Found — redirect to (no Location) — not followed"  # 운영 last_error · 실행 기록
    await c.aclose()
