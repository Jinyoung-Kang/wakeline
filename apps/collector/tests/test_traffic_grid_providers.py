"""연안 교통량(ADR-023): 공공데이터포털(apis.data.go.kr) 공급자 두 개 — 허용 호스트 · 호스트 속도 상한 · 서비스 키 정규화 · 키 가림.
실제 네트워크는 쓰지 않는다(respx)."""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import respx

from wakeline_collector import http as httpmod
from wakeline_collector import masking
from wakeline_collector.errors import describe_error
from wakeline_collector.http import HttpClient, ProviderHttpError
from wakeline_collector.marine_grid import MAX_WFS_TILE_BYTES, WfsError, WfsTooLarge
from wakeline_collector.providers.data_go_kr import (
    DATA_GO_KR_HOST,
    KOMSA_URL,
    WFS_URL,
    Grid4WfsProvider,
    KomsaTrafficProvider,
    decode_service_key,
    service_key_forms,
)
from wakeline_collector.ratelimit import (
    PRIORITY_BACKFILL,
    PRIORITY_FIXED,
    PRIORITY_PORTCALL,
    PRIORITY_ROUTE,
    RateLimiter,
    default_limiter,
)
from wakeline_collector.traffic_grid import KomsaApiError

ROOT = Path(__file__).resolve().parents[3]
KOMSA_BODY = (ROOT / "fixtures" / "komsa_realtime_sample.json").read_bytes()
WFS_BODY = (ROOT / "fixtures" / "mof_grid4_wfs_GR4_F2K41_C3.xml").read_bytes()
# 시험용 가짜 키(실제 키가 아니다): 디코딩 키는 base64 글자(+ / =)를 품고, 인코딩 키는 그 퍼센트 인코딩이다
DECODED = "Te5tKey+not/real==0123456789abcdef"
ENCODED = "Te5tKey%2Bnot%2Freal%3D%3D0123456789abcdef"


def _client() -> HttpClient:
    return HttpClient(RateLimiter(100, 100, {DATA_GO_KR_HOST: (100.0, 100)}))


def test_host_is_allow_listed_with_its_own_bucket():
    assert DATA_GO_KR_HOST == "apis.data.go.kr" and DATA_GO_KR_HOST in httpmod.ALLOWED_HOSTS
    lim = default_limiter(2.0, 0.8, 0.5, 1.0)
    assert lim.host_rps(DATA_GO_KR_HOST) == 1.0
    assert HttpClient().limiter.host_rps(DATA_GO_KR_HOST) is not None
    assert (
        PRIORITY_BACKFILL > PRIORITY_PORTCALL > PRIORITY_ROUTE > PRIORITY_FIXED
    )  # 격자 채우기는 가장 낮은 우선순위(입출항 조회보다도)


def test_urls_are_the_verified_endpoints():
    assert KOMSA_URL == "https://apis.data.go.kr/B554035/realtime/get_realtime"
    assert WFS_URL == "https://apis.data.go.kr/1192000/apVhdService_G4s/getOpnG4sWFS"


@pytest.mark.parametrize("raw", [DECODED, ENCODED, f"  {ENCODED}\n", f" {DECODED} "])
def test_service_key_is_normalized_to_the_decoded_form(raw):
    assert decode_service_key(raw) == DECODED


def test_empty_key_disables_both_providers_cleanly():
    c = _client()
    assert decode_service_key("") == "" and decode_service_key("   ") == ""
    assert not KomsaTrafficProvider(c, "").configured
    assert not Grid4WfsProvider(c, " ").configured


def test_service_key_forms_cover_raw_decoded_encoded_and_plus_encoded():
    """ADR-022 · ADR-023: 세 서비스가 같은 목록 하나를 쓴다 — 넣은 그대로 · 디코딩 · 퍼센트 인코딩 · + 인코딩."""
    forms = service_key_forms(DECODED)
    assert DECODED in forms and ENCODED in forms and "Te5tKey%2Bnot%2Freal%3D%3D0123456789abcdef" in forms
    assert service_key_forms(f" {ENCODED} ") == [ENCODED, DECODED]  # 인코딩 키를 넣었으면 원문 = 다시 인코딩한 모양(한 번만)
    assert service_key_forms("a b") == ["a b", "a%20b", "a+b"]  # + 인코딩은 공백이 있을 때만 다른 모양
    assert service_key_forms("") == [] and service_key_forms("   ") == [] and service_key_forms(None) == []


async def test_komsa_request_carries_the_key_once_encoded_and_parses():
    c = _client()
    p = KomsaTrafficProvider(c, ENCODED)  # 인코딩 키를 넣어도 한 번만 인코딩되어 나간다(이중 인코딩 → 인증 실패를 막는다)
    with respx.mock:
        route = respx.get(KOMSA_URL).mock(
            return_value=httpx.Response(200, content=KOMSA_BODY, headers={"content-type": "application/json"})
        )
        resp, snap = await p.fetch()
    q = parse_qs(urlsplit(str(route.calls.last.request.url)).query)
    assert q["serviceKey"] == [DECODED] and q["pageNo"] == ["1"] and q["numOfRows"] == ["10000"] and q["dataType"] == ["JSON"]
    assert "%252B" not in str(route.calls.last.request.url)
    assert resp.status == 200 and len(snap.items) == 3
    await c.aclose()


async def test_komsa_api_error_and_http_error_surface_without_the_key():
    c = _client()
    p = KomsaTrafficProvider(c, DECODED)
    masking.register_secrets(*service_key_forms(DECODED))
    try:
        with respx.mock:
            respx.get(KOMSA_URL).mock(
                return_value=httpx.Response(200, json={"response": {"header": {"resultCode": "30", "resultMsg": "bad key"}}})
            )
            with pytest.raises(KomsaApiError):
                await p.fetch()
        with respx.mock:
            # 게이트웨이가 요청 URL 을 본문에 되돌려 주는 경우 — 가림이 막는다
            respx.get(KOMSA_URL).mock(
                return_value=httpx.Response(500, text=f"error for serviceKey={ENCODED}&pageNo=1 key {DECODED}")
            )
            with pytest.raises(ProviderHttpError) as ei:
                await p.fetch()
        text = describe_error(ei.value)
        assert DECODED not in text and ENCODED not in text and "HTTP 500" in text
    finally:
        masking._SECRETS.clear()
        await c.aclose()


async def test_wfs_lookup_found_uses_capital_service_key_and_backfill_priority():
    c = _client()
    seen: list[int] = []
    orig = c.limiter.acquire

    async def spy(host: str, *, priority: int = 0, wait_s: float = 10.0) -> float:
        seen.append(priority)
        return await orig(host, priority=priority, wait_s=wait_s)

    c.limiter.acquire = spy  # type: ignore[method-assign]
    p = Grid4WfsProvider(c, ENCODED)
    with respx.mock:
        route = respx.get(WFS_URL).mock(return_value=httpx.Response(200, content=WFS_BODY, headers={"content-type": "text/xml"}))
        got = await p.lookup("GR4_F2K41_C3")
    q = parse_qs(urlsplit(str(route.calls.last.request.url)).query)
    assert q["ServiceKey"] == [DECODED] and q["grid_no"] == ["GR4_F2K41_C3"] and q["maxFeatures"] == ["1"]
    assert "serviceKey" not in q
    assert got.result.kind == "found" and got.result.cell is not None and got.result.cell.lat_min == 37.45
    assert got.body == WFS_BODY and got.latency_ms is not None
    assert seen == [PRIORITY_BACKFILL]
    await c.aclose()


async def test_wfs_lookup_refuses_bad_grid_ids_before_any_call():
    c = _client()
    p = Grid4WfsProvider(c, DECODED)
    with respx.mock(assert_all_called=False) as m:
        route = m.get(url__regex=r".*").mock(return_value=httpx.Response(200))
        for bad in ("GR4 X", "../x", "", "G" * 33, "a&ServiceKey=x"):
            with pytest.raises(ValueError):
                await p.lookup(bad)
        assert route.call_count == 0
    await c.aclose()


async def test_wfs_404_and_error_bodies_are_errors():
    c = _client()
    p = Grid4WfsProvider(c, DECODED)
    with respx.mock:
        respx.get(WFS_URL).mock(return_value=httpx.Response(404, text="<html><title>404 Not Found</title></html>"))
        with pytest.raises(ProviderHttpError):
            await p.lookup("GR4_F2K41_C3")
    with respx.mock:
        respx.get(WFS_URL).mock(
            return_value=httpx.Response(
                200, text="<ServiceExceptionReport><ServiceException>x</ServiceException></ServiceExceptionReport>"
            )
        )
        with pytest.raises(WfsError):
            await p.lookup("GR4_F2K41_C3")
    await c.aclose()


# ---- bbox 타일(ADR-023 2026-10-01 bbox 개정) -------------------------------------------------------------------------------------


async def test_wfs_bbox_sends_the_verified_query_shape_and_parses_off_the_event_loop(monkeypatch):
    """확인한 호출(2026-10-01)의 모양 그대로: ServiceKey(한 칸 조회와 같은 인코딩 — 한 번만) · bbox=xmin,ymin,xmax,ymax(EPSG:5179 m, 쉼표 그대로 —
    기록한 호출처럼) · srs=EPSG:5179 · maxFeatures=1000. 해석(32 km 타일 약 7 ms — 잰 값)은 스레드에서."""
    from wfs_tiles import FakeGrid

    from wakeline_collector.providers import data_go_kr

    c = _client()
    seen: list[int] = []
    orig = c.limiter.acquire

    async def spy(host: str, *, priority: int = 0, wait_s: float = 10.0) -> float:
        seen.append(priority)
        return await orig(host, priority=priority, wait_s=wait_s)

    c.limiter.acquire = spy  # type: ignore[method-assign]
    threads: list[str] = []
    to_thread = data_go_kr.asyncio.to_thread

    async def spy_thread(fn, /, *args, **kw):
        threads.append(fn.__name__)
        return await to_thread(fn, *args, **kw)

    monkeypatch.setattr(data_go_kr.asyncio, "to_thread", spy_thread)
    box = (916000, 1935000, 926000, 1945000)
    body = FakeGrid().body(box)
    p = Grid4WfsProvider(c, ENCODED)
    with respx.mock:
        route = respx.get(WFS_URL).mock(return_value=httpx.Response(200, content=body, headers={"content-type": "text/xml"}))
        got = await p.bbox(box)
    url = str(route.calls.last.request.url)
    query = urlsplit(url).query
    assert "&bbox=916000,1935000,926000,1945000&srs=EPSG:5179&maxFeatures=1000" in query
    q = parse_qs(query)
    assert q["ServiceKey"] == [DECODED] and "grid_no" not in q and "%252B" not in url
    assert len(got.result.cells) == 28 and got.result.truncation is None and got.body == body and got.latency_ms is not None
    assert threads == ["parse_wfs_tile"] and seen == [PRIORITY_BACKFILL]
    await c.aclose()


@pytest.mark.parametrize(
    "box",
    [
        (0, 0, 0, 10),
        (10, 0, 0, 10),
        (0, 0, 64_001, 10),
        (0, 0, 10, 64_001),
        (0.5, 0, 10, 10),
        (True, 0, 10, 10),
        ("0", 0, 10, 10),
    ],
)
async def test_wfs_bbox_refuses_bad_boxes_before_any_call(box):
    c = _client()
    p = Grid4WfsProvider(c, DECODED)
    with respx.mock(assert_all_called=False) as m:
        route = m.get(url__regex=r".*").mock(return_value=httpx.Response(200))
        with pytest.raises(ValueError):
            await p.bbox(box)
        assert route.call_count == 0
    await c.aclose()


async def test_wfs_bbox_checks_the_answer_against_the_box_it_asked():
    """검토 지적(2026-10-01): 다른 곳의 칸만 담은 답이 그 타일의 답으로 적혔다 — 공급자는 물은 상자를 해석에 넘긴다(상자와 닿지 않는 칸은 빼고,
    그런 칸이 과반이면 오류)."""
    from wfs_tiles import FakeGrid

    c = _client()
    p = Grid4WfsProvider(c, DECODED)
    far = FakeGrid().body((960000, 1760000, 992000, 1792000))
    with respx.mock:
        respx.get(WFS_URL).mock(return_value=httpx.Response(200, content=far))
        with pytest.raises(WfsError, match="features invalid"):
            await p.bbox((896000, 1920000, 928000, 1952000))
    await c.aclose()


async def test_wfs_bbox_oversized_body_is_refused_unparsed():
    c = _client()
    p = Grid4WfsProvider(c, DECODED)
    with respx.mock:
        respx.get(WFS_URL).mock(return_value=httpx.Response(200, content=b"<a>" + b" " * MAX_WFS_TILE_BYTES + b"</a>"))
        with pytest.raises(WfsTooLarge):
            await p.bbox((0, 0, 32000, 32000))
    await c.aclose()


async def test_wfs_bbox_http_error_echoing_the_url_is_masked():
    c = _client()
    p = Grid4WfsProvider(c, DECODED)
    masking.register_secrets(*service_key_forms(DECODED))
    try:
        with respx.mock:
            respx.get(WFS_URL).mock(
                return_value=httpx.Response(502, text=f"bad gateway for ?ServiceKey={ENCODED}&bbox=0,0,1,1 {DECODED}")
            )
            with pytest.raises(ProviderHttpError) as ei:
                await p.bbox((0, 0, 32000, 32000))
        text = describe_error(ei.value)
        assert DECODED not in text and ENCODED not in text and "HTTP 502" in text
    finally:
        masking._SECRETS.clear()
        await c.aclose()


def test_collector_main_registers_every_form_of_the_key(monkeypatch, caplog):
    from wakeline_collector import main as col_main

    root = logging.getLogger()
    before = list(root.handlers)
    try:
        col_main.configure_logging(
            col_main.secret_values(col_main.settings.model_copy(update={"data_go_kr_service_key": ENCODED}))
        )
        for form in (DECODED, ENCODED):
            assert form not in (masking.mask(f"x {form} y") or "")
    finally:
        root.handlers[:] = before
        masking._SECRETS.clear()
