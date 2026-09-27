"""연결 상태·공백 기록: 공백 시작은 마지막 메시지 시각, 끝은 재구독 뒤 첫 메시지 시각, 재시작 이어받기."""

from __future__ import annotations

from test_ais_helpers import T0_EPOCH

from wakeline_collector.ais.feed import FeedState, GapTracker, parse_iso
from wakeline_collector.ais.parse import iso_ms


class Clock:
    def __init__(self, t: float) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def test_gap_open_close_and_idempotent_open():
    g = GapTracker()
    assert g.close(T0_EPOCH) is None  # 열린 공백 없음
    assert g.open(T0_EPOCH, "server closed (1006)") is True
    assert g.open(T0_EPOCH + 5, "other") is False  # 시작·원인을 덮어쓰지 않는다
    ev = g.close(T0_EPOCH + 30)
    assert ev == {"started_at": iso_ms(T0_EPOCH), "ended_at": iso_ms(T0_EPOCH + 30), "reason": "server closed (1006)"}
    assert list(g.pending) == [ev] and g.last == ev and g.open_since is None


def test_gap_zero_length_is_not_recorded_and_reason_is_bounded():
    g = GapTracker()
    g.open(T0_EPOCH, "x" * 500)
    assert len(g.reason) == 200
    assert g.close(T0_EPOCH) is None and not g.pending and g.open_since is None


def test_gap_pending_is_bounded():
    g = GapTracker(pending_max=2)
    for i in range(3):
        g.open(T0_EPOCH + 10 * i, f"r{i}")
        g.close(T0_EPOCH + 10 * i + 1)
    assert [e["reason"] for e in g.pending] == ["r1", "r2"] and g.pending_dropped == 1


def test_restore_from_previous_status():
    now = T0_EPOCH + 100
    g = GapTracker()
    g.restore(
        {"provider": "aisstream", "gap_open_since": iso_ms(T0_EPOCH), "gap_reason": "server closed (1006)"}, "aisstream", now
    )
    assert g.open_since == parse_iso(iso_ms(T0_EPOCH)) and g.reason == "server closed (1006)"
    g2 = GapTracker()
    g2.restore(
        {
            "provider": "aisstream",
            "gap_open_since": "",
            "last_msg_at": iso_ms(T0_EPOCH),
            "last_gap_started_at": iso_ms(T0_EPOCH - 100),
            "last_gap_ended_at": iso_ms(T0_EPOCH - 50),
            "last_gap_reason": "idle",
        },
        "aisstream",
        now,
    )
    assert g2.open_since is not None and g2.reason == "ais process restart"
    assert g2.last == {"started_at": iso_ms(T0_EPOCH - 100), "ended_at": iso_ms(T0_EPOCH - 50), "reason": "idle"}
    g3 = GapTracker()
    g3.restore({"provider": "fixture", "last_msg_at": iso_ms(T0_EPOCH)}, "aisstream", now)  # 공급자가 다르면 잇지 않는다
    assert g3.open_since is None
    g4 = GapTracker()
    g4.restore({"provider": "aisstream", "last_msg_at": iso_ms(now + 3600)}, "aisstream", now)  # 미래 시각은 믿지 않는다
    assert g4.open_since is None
    g5 = GapTracker()
    g5.restore({}, "aisstream", now)
    assert g5.open_since is None


def test_parse_iso():
    assert parse_iso("2026-09-27T16:29:43.949Z") is not None
    assert parse_iso("2026-09-27T16:29:43") is None and parse_iso("x") is None and parse_iso("") is None


def test_feed_session_lifecycle_records_gap_from_last_message():
    wall, mono = Clock(T0_EPOCH), Clock(500.0)
    f = FeedState("aisstream", wall=wall, mono=mono)
    f.on_connecting()
    assert f.state == "connecting" and f.changed.is_set()
    f.changed.clear()
    f.on_subscribed("18,105,46,150", deflate=True)
    assert f.connected and f.state == "subscribed" and f.connected_since == T0_EPOCH
    f.on_message(T0_EPOCH + 1)
    assert f.state == "receiving" and f.changed.is_set()
    f.changed.clear()
    f.on_message(T0_EPOCH + 2)
    assert not f.changed.is_set()  # 메시지마다 켜지 않는다
    mono.t += 90
    healthy = f.on_disconnected("connection lost (no close frame)")
    assert healthy == 90 and not f.connected and f.sessions_ended == 1
    assert f.gaps.open_since == T0_EPOCH + 2  # 끊긴 순간이 아니라 마지막 메시지
    f.on_backoff(1.1)
    assert f.state == "backoff" and f.backoff_s == 1.1
    f.on_connecting()
    f.on_subscribed("18,105,46,150", deflate=True)
    assert f.gaps.open_since is not None  # 구독만으로는 닫지 않는다(첫 메시지가 증거)
    f.on_message(T0_EPOCH + 40)
    assert f.gaps.open_since is None
    assert f.gaps.last == {
        "started_at": iso_ms(T0_EPOCH + 2),
        "ended_at": iso_ms(T0_EPOCH + 40),
        "reason": "connection lost (no close frame)",
    }


def test_feed_no_gap_before_any_data_and_stop_opens_gap():
    f = FeedState("aisstream")
    assert f.on_disconnected("network error: ConnectionRefusedError") is None
    assert f.gaps.open_since is None  # 한 번도 받지 못했으면 '끊김' 이 아니다
    f.on_subscribed("x", deflate=False)
    f.on_resubscribed("y")
    assert f.bbox == "y" and f.subscribe_updates == 1
    f.on_message(T0_EPOCH)
    f.on_error("Api Key Is Not Valid")
    assert f.provider_error == "Api Key Is Not Valid" and f.last_error == "network error: ConnectionRefusedError"
    f.on_stopped()
    assert f.state == "stopped" and not f.connected and f.gaps.open_since == T0_EPOCH and f.gaps.reason == "ais process stopped"


def test_feed_disabled():
    f = FeedState("aisstream")
    f.on_disabled("AISSTREAM_API_KEY not set")
    assert f.state == "disabled" and f.last_error == "AISSTREAM_API_KEY not set"
