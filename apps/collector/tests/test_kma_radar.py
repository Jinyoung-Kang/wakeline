from datetime import UTC, datetime

from skywx_collector.providers.kma_radar import latest_tm


def test_latest_tm_is_kst_10min_floor_minus_lag():
    # 2026-09-27 09:37 UTC = 18:37 KST → 10분 지연 → 18:27 → 10분 내림 → 18:20
    assert latest_tm(datetime(2026, 9, 27, 9, 37, tzinfo=UTC)) == "202609271820"
    assert latest_tm(datetime(2026, 9, 27, 15, 5, tzinfo=UTC)) == "202609272350"
