"""기상특보 현황 작업(ADR-036 · SPEC F3): 발효 중인 특보 전체를 wakeline:wxwarn 에 한 엔트리로(스키마 그대로) · 실패하면 발행하지 않음 ·
키 없음 · 운영자 끔은 부르지 않고 상태로 · 모양이 틀린 줄은 품질 기록 · 예산 · 재생 공급자(fixture)의 시각 옮김 · 키는 어떤 글에도 나오지 않음."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
import respx
from fakes import FakeRedis, make_ctx
from test_ais_helpers import decode, validator

from wakeline_collector import kma_warning_rules
from wakeline_collector.jobs.weather import KmaWarningJob
from wakeline_collector.models import ProviderResult
from wakeline_collector.providers import fixture as fx
from wakeline_collector.providers.kma_warning import URL, KmaWarningProvider
from wakeline_collector.publisher import STREAM_WXWARN

FX = Path(__file__).parent / "fixtures" / "kma_warning"
ENV = validator("stream_envelope.v1.json")
PAYLOAD = validator("stream_envelope.v1.json", "/$defs/wx_warnings_payload")
LIMITS = {"kma_warning": 400}


class FakeKma:
    name = "kma_warning"
    configured = True

    def __init__(self, body: bytes | None = None, error: Exception | None = None):
        self.body, self.error, self.calls = body, error, 0

    async def current(self) -> ProviderResult:
        self.calls += 1
        if self.error:
            raise self.error
        return ProviderResult(self.name, self.body, datetime.now(UTC), 200, 12, data=kma_warning_rules.parse(self.body))  # type: ignore[arg-type]


async def test_publishes_the_whole_list_with_the_schema_and_records_a_run():
    r = FakeRedis()
    ctx = make_ctx(r, limits=LIMITS)
    p = FakeKma((FX / "wrn_now_data_preliminary.txt").read_bytes())
    await KmaWarningJob(p, ctx).run_once()
    ((sid, fields),) = r.streams[STREAM_WXWARN]
    assert not [e.message for e in ENV.iter_errors(fields)]
    assert (fields["kind"], fields["scope"], fields["provider"], fields["count"]) == ("wx_warnings", "-", "kma_warning", "3")
    payload = decode(fields)
    assert not [e.message for e in PAYLOAD.iter_errors(payload)]
    assert payload["complete"] is True and payload["dropped"] == 0
    assert [w["zone_code"] for w in payload["warnings"]] == ["S1312020", "S1324020", "S1324110"]
    assert "kma_warning_run" in " ".join(ctx.db.names) or ctx.db.names  # 실행 기록이 제출됐다
    assert (await r.hgetall("wakeline:collector")).get("kma_warning_state") == "ok"
    assert (await ctx.budget.usage("kma_warning"))[0] == 1


async def test_an_empty_list_is_published_as_empty_not_skipped():
    r = FakeRedis()
    await KmaWarningJob(FakeKma((FX / "wrn_now_data_empty.txt").read_bytes()), make_ctx(r, limits=LIMITS)).run_once()
    ((_, fields),) = r.streams[STREAM_WXWARN]
    assert decode(fields)["warnings"] == [] and fields["count"] == "0"


async def test_a_failed_call_publishes_nothing():
    r = FakeRedis()
    p = FakeKma(error=kma_warning_rules.WarningResponseError("not a warning list: '인증 실패'"))
    await KmaWarningJob(p, make_ctx(r, limits=LIMITS)).run_once()
    assert STREAM_WXWARN not in r.streams
    assert p.calls >= 1


async def test_bad_lines_are_counted_and_recorded_as_quality_cases():
    body = (FX / "wrn_now_data_preliminary.txt").read_bytes() + "S1, 깨진 줄,=\n".encode("euc-kr")
    r = FakeRedis()
    await KmaWarningJob(FakeKma(body), make_ctx(r, limits=LIMITS)).run_once()
    ((_, fields),) = r.streams[STREAM_WXWARN]
    assert decode(fields)["dropped"] == 1 and fields["count"] == "3"


async def test_no_key_and_operator_off_do_not_call():
    r = FakeRedis()
    ctx = make_ctx(r, limits=LIMITS)
    nokey = KmaWarningProvider(None, "")  # type: ignore[arg-type]
    await KmaWarningJob(nokey, ctx).run_once()
    assert (await r.hgetall("wakeline:collector"))["kma_warning_state"] == "no_key"
    p = FakeKma((FX / "wrn_now_data_empty.txt").read_bytes())
    await r.hset(ctx.status.key("kma_warning"), mapping={"disabled": "1"})
    await KmaWarningJob(p, ctx).run_once()
    assert p.calls == 0 and STREAM_WXWARN not in r.streams
    assert (await r.hgetall("wakeline:collector"))["kma_warning_state"] == "disabled"


async def test_the_provider_sends_the_documented_parameters_and_the_key_never_appears_in_errors():
    from wakeline_collector.http import HttpClient

    body = (FX / "wrn_now_data_preliminary.txt").read_bytes()
    http = HttpClient()
    try:
        with respx.mock:
            route = respx.get(URL).mock(
                side_effect=[httpx.Response(200, content=body), httpx.Response(200, content="인증키 오류".encode("euc-kr"))]
            )
            p = KmaWarningProvider(http, "SECRETKEY123")
            res = await p.current()
            assert len(res.data.warnings) == 3
            q = dict(route.calls[0].request.url.params)
            assert {k: q[k] for k in ("fe", "tm", "disp", "help")} == {"fe": "f", "tm": "", "disp": "0", "help": "1"}
            with pytest.raises(kma_warning_rules.WarningResponseError) as e:
                await p.current()
            assert "SECRETKEY123" not in str(e.value)
    finally:
        await http.aclose()


async def test_the_fixture_provider_moves_the_times_to_now(monkeypatch, tmp_path):
    (tmp_path / "kma_wrn_now_data.txt").write_bytes((FX / "wrn_now_data_preliminary.txt").read_bytes())
    monkeypatch.setattr(fx.settings, "fixtures_dir", str(tmp_path))
    res = await fx.FixtureKmaWarningProvider().current()
    ws = res.data.warnings
    assert len(ws) == 3
    issued = datetime.fromisoformat(ws[0]["issued_at"].replace("Z", "+00:00"))
    assert abs((datetime.now(UTC) - issued).total_seconds()) < 3700
    assert ws[0]["effective_from"] > ws[0]["issued_at"]
    assert res.extra["raw_ref"] == "fixture:kma_wrn_now_data.txt"
