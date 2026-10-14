"""QA-1140(AWS 출시 QA · 수집기 · 비밀값): 공급자 오류 본문을 **먼저 자르고 나중에 가린다** — 자르는 경계에 걸친 키는 앞부분이 그대로 남는다.

masking.py 는 "설정 비밀값 자체를 어디에 나오든 가린다 — 공급자가 키를 응답 본문에 되돌려 주는 경우처럼 모양 규칙이 못 잡는 경우를 막는다"(R-83)고 한다.
그런데 값으로 가리기는 **키 전체**가 글에 있어야 맞는다. 오류 본문은 가리기 전에 두 번 잘린다:
- http.py:218 `ProviderHttpError(status, body[:200]…)` · http_errors.py:37-39 `body_head[:200]` — 예외 글(str(e) · 트레이스백 · `%s` 로그)
- errors.py:71 `_one_line(body)[:BODY_HEAD]`(120) → errors.py:146 에서야 `mask` — 운영 상태 last_error · ingest_run.error_text · 경고 로그
키가 그 경계(200 · 120 글자)에 걸치면 키의 앞부분(경계까지)이 가려지지 않고 로그 · /ops RUNS · 공급자 상태 · /logs 에 남는다.
JSON 모양(`"authKey": "…"`)도 닫는 따옴표가 잘려 나가면 모양 규칙(masking.py:44)이 맞지 않는다.

기대: 오류 글 어디에도 등록한 키의 8글자 이상 조각이 남지 않는다(가린 뒤 자르기). 키는 이 시험만의 가짜 값이다.
실행: cd apps/collector && uv run --offline pytest tests/qa/test_qa_1140_error_body_cut_before_masking.py -q
"""

from __future__ import annotations

import logging

import httpx
import pytest
import respx
from fakes import FakeRedis, make_ctx

from wakeline_collector import masking
from wakeline_collector.errors import BODY_HEAD, describe_error
from wakeline_collector.http import HttpClient, ProviderHttpError
from wakeline_collector.jobs import weather
from wakeline_collector.jobs.weather import KmaWarningJob
from wakeline_collector.masking import MaskFilter
from wakeline_collector.providers.kma_warning import URL, KmaWarningProvider
from wakeline_collector.ratelimit import RateLimiter

FAKE_KEY = "QA1140fakeKmaKey0123456789abcdefXYZ"  # 35글자 — 가짜(이 시험만)
MIN_PIECE = 8  # 이 길이 이상의 키 조각이 보이면 샌 것으로 본다


def _leaked(text: str | None, key: str = FAKE_KEY, n: int = MIN_PIECE) -> str:
    """text 에 남은 key 의 가장 긴 연속 조각(n 글자 이상) — 없으면 ''."""
    text = text or ""
    best = ""
    for i in range(len(key)):
        for j in range(len(key), i + n - 1, -1):
            if j - i <= len(best):
                break
            if key[i:j] in text:
                best = key[i:j]
                break
    return best


@pytest.fixture
def secret():
    saved = set(masking._SECRETS)
    masking.register_secrets(FAKE_KEY)  # main.configure_logging 이 하는 것과 같다(R-83)
    yield FAKE_KEY
    masking._SECRETS.clear()
    masking._SECRETS.update(saved)


def _client() -> HttpClient:
    return HttpClient(RateLimiter(100, 100, {"apihub.kma.go.kr": (100.0, 100)}))


async def _provider_error(body: bytes, status: int = 401) -> ProviderHttpError:
    http = _client()
    try:
        with respx.mock:
            respx.get(URL).mock(return_value=httpx.Response(status, content=body))
            with pytest.raises(ProviderHttpError) as ei:
                await KmaWarningProvider(http, FAKE_KEY).current()
        return ei.value
    finally:
        await http.aclose()


def test_qa_1140_whole_key_in_an_error_body_is_masked(secret):
    """대조군: 키 전체가 잘리지 않은 자리에 있으면 값으로 가리기가 잡는다(R-83 이 약속한 동작)."""
    body = f"401 unregistered authentication key {FAKE_KEY} for wrn_now_data".encode()
    e = ProviderHttpError(401, body[:200].decode())
    assert _leaked(describe_error(e)) == "" and _leaked(masking.mask(str(e))) == ""


@pytest.mark.parametrize(
    ("label", "pad", "shape"),
    [
        ("plain echo across the 200-char exception cut", 190, "{key}"),
        ("plain echo across the 120-char error-text cut", BODY_HEAD - 10, "{key}"),
        ("JSON echo cut before the closing quote", BODY_HEAD - 25, '{{"result":"error","authKey":"{key}"}}'),
    ],
)
async def test_qa_1140_a_key_split_by_the_cut_leaks_its_head(secret, label, pad, shape):
    prefix = "E" * (pad - len(shape.split("{key}")[0].format(key="")))
    body = (prefix + shape.format(key=FAKE_KEY)).encode()
    e = await _provider_error(body)
    surfaces = {
        "str(e) → traceback · %s logs": masking.mask(str(e)),
        "describe_error → last_error · error_text · WARN": describe_error(e),
    }
    leaks = {where: _leaked(text) for where, text in surfaces.items() if _leaked(text)}
    assert not leaks, f"[{label}] unmasked key fragments: {leaks}"


async def test_qa_1140_a_200_reply_that_is_not_a_warning_list_cuts_at_80_before_masking(secret):
    """같은 순서의 다른 자리: kma_warning_rules.py:154 `not a warning list: {text.strip()[:80]!r}` — 200 으로 온 인증 실패 글(확인된 모양 —
    test_kma_warning_job 의 '인증키 오류')이 키를 되돌려 주면 80 글자에서 잘린 뒤에야 가려진다."""
    from wakeline_collector.kma_warning_rules import WarningResponseError, parse

    body = ("인증키 오류 " + "E" * 62 + FAKE_KEY).encode("euc-kr")
    with pytest.raises(WarningResponseError) as ei:
        parse(body)
    assert not _leaked(describe_error(ei.value)), describe_error(ei.value)


def test_qa_1140_an_ais_close_reason_is_cut_at_120_before_redaction_and_becomes_a_public_gap_reason(secret):
    """같은 순서의 AIS 자리: client.py:117 · 121 · 248 `reason[:120]` → client.py:212 `self.redact(reason)` → FeedState.on_disconnected 의 공백 원인 →
    ais_gap 봉투 → api `/api/v1/ais/gaps` 의 reason(공개 경로 — ShipController.aisGaps). WebSocket close 사유는 최대 123 바이트라 끝 3 글자만 잘려도
    값으로 가리기가 맞지 않는다(aisstream 이 키를 사유에 되돌려 주는지는 확인하지 못했다)."""
    from websockets.exceptions import ConnectionClosed
    from websockets.frames import Close

    from wakeline_collector.ais.client import _closed_reason, make_redactor
    from wakeline_collector.ais.feed import FeedState

    reason = make_redactor(FAKE_KEY)(_closed_reason(ConnectionClosed(Close(1008, "y" * 88 + FAKE_KEY), None)))
    feed = FeedState("aisstream", wall=lambda: 1_800_000_100.0)
    feed.on_message(1_800_000_000.0)
    feed.on_disconnected(reason)
    gap = feed.gaps.close(1_800_000_200.0)
    assert gap is not None and not _leaked(gap["reason"]), gap


async def test_qa_1140_warning_job_stores_and_logs_the_head_of_an_echoed_key(secret, caplog, monkeypatch):
    """작업 경로 전체(KmaWarningJob → _guard): 공급자 상태 last_error(Redis — /ops) · 실행 기록 error_text(DB — /ops RUNS) · 경고 로그(/logs)."""
    body = ("E" * (BODY_HEAD - 12) + FAKE_KEY).encode()  # 키가 120 경계에 걸린다
    stored: list[str] = []
    r = FakeRedis()
    ctx = make_ctx(r, limits={"kma_warning": 400})
    real_record = ctx.db.record_run

    def record_run(*a, **kw):  # db.record_run 은 error_text 를 mask() 해서 저장한다 — 저장될 글을 그대로 모은다
        stored.append(masking.mask(kw.get("error_text")) or "")
        return real_record(*a, **kw)

    monkeypatch.setattr(ctx.db, "record_run", record_run)
    caplog.set_level(logging.WARNING, logger="job.weather")
    caplog.handler.addFilter(MaskFilter())  # 운영 로그 경로(install_log_masking)와 같다
    http = _client()
    try:
        with respx.mock:
            respx.get(URL).mock(return_value=httpx.Response(401, content=body))
            await KmaWarningJob(KmaWarningProvider(http, FAKE_KEY), ctx).run_once()
    finally:
        await http.aclose()
    status = (await r.hgetall("wakeline:provider:kma_warning")).get("last_error", "")
    logs = "\n".join(rec.getMessage() for rec in caplog.records if rec.name == weather.log.name)
    leaks = {
        where: _leaked(text)
        for where, text in {"provider last_error": status, "ingest_run.error_text": " | ".join(stored), "WARN log": logs}.items()
        if _leaked(text)
    }
    assert status and stored and logs, (status, stored, logs)  # 실패가 세 곳 모두에 기록됐다
    assert not leaks, f"unmasked key fragments: {leaks}"
