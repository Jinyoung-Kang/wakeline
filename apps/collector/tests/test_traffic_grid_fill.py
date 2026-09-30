"""연안 교통량 격자 기하 채우기가 수렴하는가(ADR-023 2026-10-01 개정) — 부정 결과를 잊지 않는지. 외부 호출 · 실제 Redis/DB 없이(가짜)."""

from __future__ import annotations

from datetime import timedelta

from test_traffic_grid_job import T0

from wakeline_collector.jobs import traffic_grid as tg


def test_a_full_negative_cache_never_forgets_a_result(monkeypatch):
    """전에는 부정 캐시(메모리)가 MAX_TRACKED 에 닿으면 새 not_found 를 적지 않고 대기열에서만 뺐다 — 다음 스냅샷에서 다시 넣어 볼 때마다 다시
    물었다(끝없는 예산 낭비). 이제 기한이 지난 항목부터, 없으면 가장 먼저 끝나는 항목을 비우고 적는다."""
    monkeypatch.setattr(tg, "MAX_TRACKED", 2)
    g = tg.GridGeometry()
    g.observe([("GR4_A", 1), ("GR4_B", 1)], T0)
    g.mark_negative("GR4_A", "not_found", T0)
    g.mark_negative("GR4_B", "failed", T0)  # 1일 — 먼저 끝난다
    g.observe([("GR4_C", 1)], T0)
    g.mark_negative("GR4_C", "not_found", T0)
    assert g.observe([("GR4_C", 1)], T0 + timedelta(hours=1)) == 0  # 다시 묻지 않는다
    assert set(g.negative) == {"GR4_A", "GR4_C"}  # 가장 먼저 끝나는 failed 를 비웠다
    old = T0 - timedelta(seconds=tg.NEGATIVE_TTL_S + 1)
    g.negative["GR4_A"] = tg.Negative("not_found", old)  # 기한이 지났다
    g.observe([("GR4_D", 1)], T0)
    g.mark_negative("GR4_D", "off_grid", T0)
    assert set(g.negative) == {"GR4_C", "GR4_D"}  # 기한이 지난 항목부터
