"""구역(연결)별 상태 모음(계약 v4 §D): 합계의 의미, shards 배열, 재시작 이어받기(같은 scope 만), 구역 없애기."""

from __future__ import annotations

import json

import pytest
from test_ais_helpers import T0_EPOCH as _T0

from wakeline_collector.ais.parse import iso_ms
from wakeline_collector.ais.shards import SHARD_FIELDS, STATE_RANK, ShardSet, previous_shards

A, B, C = "-90,-180,90,0", "-90,45,90,180", "18,105,46,150"
T0_EPOCH = float(int(_T0))  # 상태 해시는 ms 까지 — 되읽은 시각과 바로 비교하려고 초 단위로


class Clock:
    def __init__(self, t: float) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def _set(provider: str = "aisstream") -> tuple[ShardSet, Clock, Clock]:
    wall, mono = Clock(T0_EPOCH), Clock(1000.0)
    return ShardSet(provider, wall=wall, mono=mono), wall, mono


def _receiving(sh, scope: str, at: float) -> None:
    sh.feed.on_connecting()
    sh.feed.on_subscribed(scope, deflate=True)
    sh.feed.on_message(at)


def test_one_shard_aggregates_are_that_shard():
    ss, wall, _ = _set()
    s = ss.add(C)
    assert ss.state == "starting" and ss.shards_view()[0]["scope"] == C
    _receiving(s, C, T0_EPOCH + 1)
    assert ss.state == "receiving" and ss.connected and ss.connected_since == T0_EPOCH
    assert ss.last_msg_at == T0_EPOCH + 1 and ss.bbox == C and ss.deflate is True and ss.msgs_total == 1
    s.feed.on_disconnected("server closed (1006)")
    s.feed.on_backoff(2.5)
    assert ss.state == "backoff" and not ss.connected and ss.connected_since is None and ss.backoff_s == 2.5
    assert ss.gap_open() == (T0_EPOCH + 1, "server closed (1006)") and ss.last_error == "server closed (1006)"
    view = ss.shards_view()
    assert len(view) == 1 and tuple(view[0]) == SHARD_FIELDS
    assert view[0] == {
        "scope": C,
        "state": "backoff",
        "connected": False,
        "last_msg_at": iso_ms(T0_EPOCH + 1),
        "msgs_per_s": None,
        "lag_p50_s": None,
        "gap_open_since": iso_ms(T0_EPOCH + 1),
        "gap_reason": "server closed (1006)",
        "sessions_ended": 1,
    }


def test_aggregates_across_shards_follow_the_contract():
    ss, wall, _ = _set()
    a, b, c = ss.add(A), ss.add(B), ss.add(C)
    assert [s.position for s in (a, b, c)] == [0, 1, 2] and len({a.id, b.id, c.id}) == 3
    wall.t = T0_EPOCH + 1
    _receiving(a, A, T0_EPOCH + 10)
    wall.t = T0_EPOCH + 3
    _receiving(b, B, T0_EPOCH + 5)
    assert not ss.connected  # c 는 아직 — connected = 모든 구역 연결
    _receiving(c, C, T0_EPOCH + 2)
    assert ss.connected and ss.connected_since == T0_EPOCH + 3  # 모두 연결된 뒤로
    assert ss.last_msg_at == T0_EPOCH + 10  # 최댓값
    a.msgs_per_s, b.msgs_per_s, c.msgs_per_s = 40.0, 10.5, None
    a.lag_p50_s, b.lag_p50_s, c.lag_p50_s = 1.9, 6.2, None
    assert ss.msgs_per_s == 50.5 and ss.lag_p50_s == 6.2  # 합 · 최댓값
    # 두 구역 끊김: 가장 이른 공백이 합계, state 는 가장 나쁜 구역
    wall.t = T0_EPOCH + 20
    b.feed.on_disconnected("client closed (1011 keepalive ping timeout)")
    wall.t = T0_EPOCH + 21
    c.feed.on_disconnected("server closed (1006)")
    c.feed.on_backoff(4.0)
    b.feed.on_connecting()
    assert ss.gap_open() == (T0_EPOCH + 2, "server closed (1006)")
    assert ss.state == "backoff" and ss.backoff_s == 4.0 and not ss.connected
    assert ss.last_error == "server closed (1006)"  # 가장 최근
    view = {v["scope"]: v for v in ss.shards_view()}
    assert view[A]["gap_open_since"] is None and view[A]["gap_reason"] is None and view[A]["connected"] is True
    assert view[A]["msgs_per_s"] == 40.0 and view[A]["lag_p50_s"] == 1.9
    assert view[B]["gap_open_since"] == iso_ms(T0_EPOCH + 5) and view[B]["state"] == "connecting"
    assert view[C]["msgs_per_s"] is None and view[C]["sessions_ended"] == 1
    assert ss.bbox == f"{A}|{B}|{C}" and ss.msgs_total == 3 and ss.sessions_ended == 2
    json.dumps(ss.shards_view())  # 그대로 JSON 이 된다


def test_state_is_the_worst_shard_and_empty_is_starting():
    ss, _, _ = _set()
    assert ss.state == "starting" and not ss.connected and ss.last_msg_at is None and ss.msgs_per_s is None
    a, b = ss.add(A), ss.add(B)
    a.feed.state, b.feed.state = "receiving", "subscribed"
    assert ss.state == "subscribed"
    for worse in ("starting", "connecting", "backoff", "disabled", "stopped"):
        b.feed.state = worse
        assert ss.state == worse
    assert max(STATE_RANK, key=STATE_RANK.__getitem__) == "stopped"


def test_deflate_and_errors_aggregate():
    ss, wall, _ = _set()
    a, b = ss.add(A), ss.add(B)
    assert ss.deflate is None and ss.provider_error == "" and ss.last_error == ""
    a.feed.on_subscribed(A, deflate=True)
    assert ss.deflate is True
    b.feed.on_subscribed(B, deflate=False)
    assert ss.deflate is False  # 하나라도 아니면 아니다
    b.feed.on_error("older")
    wall.t += 1
    a.feed.on_error("newer")
    assert ss.provider_error == "newer"
    wall.t += 1
    ss.on_provider_error(b.id, "from b")
    assert b.feed.provider_error == "from b" and ss.provider_error == "from b"
    ss.on_provider_error(999, "unknown shard")  # 없앤 구역 — 버린다
    assert "unknown shard" not in (a.feed.provider_error, b.feed.provider_error)


def _prev_v4(**top: str) -> dict[str, str]:
    shards = [
        {"scope": A, "state": "stopped", "gap_open_since": iso_ms(T0_EPOCH - 60), "gap_reason": "ais process stopped"},
        {"scope": B, "state": "stopped", "gap_open_since": None, "last_msg_at": iso_ms(T0_EPOCH - 30)},
        {"scope": "1,1,2,2", "state": "stopped", "gap_open_since": iso_ms(T0_EPOCH - 90), "gap_reason": "x"},
    ]
    return {"provider": "aisstream", "shards": json.dumps(shards), **top}


def test_restore_carries_each_gap_over_only_to_the_same_scope():
    ss, _, _ = _set()
    ss.load_previous(
        _prev_v4(
            last_gap_started_at=iso_ms(T0_EPOCH - 500),
            last_gap_ended_at=iso_ms(T0_EPOCH - 400),
            last_gap_reason="idle 120 s — no messages",
        )
    )
    a, b, c = ss.add(A), ss.add(B), ss.add(C)
    assert a.feed.gaps.open_since == T0_EPOCH - 60 and a.feed.gaps.reason == "ais process stopped" and a.feed.gaps.scope == A
    assert b.feed.gaps.open_since == T0_EPOCH - 30 and b.feed.gaps.reason == "ais process restart"
    assert c.feed.gaps.open_since is None  # 이전 실행에 없던 구역
    assert ss.last_gap() == {
        "started_at": iso_ms(T0_EPOCH - 500),
        "ended_at": iso_ms(T0_EPOCH - 400),
        "reason": "idle 120 s — no messages",
    }
    # 한 번 이은 기록은 다시 잇지 않고, 기동 뒤 새로 만든 구역(restore=False)도 잇지 않는다
    assert ss.add(A).feed.gaps.open_since is None
    ss2, _, _ = _set()
    ss2.load_previous(_prev_v4())
    assert ss2.add(A, restore=False).feed.gaps.open_since is None


def test_restore_ignores_another_provider_and_malformed_shards():
    ss, _, _ = _set()
    ss.load_previous({**_prev_v4(), "provider": "fixture"})
    assert ss.add(A).feed.gaps.open_since is None
    ss2, _, _ = _set()
    ss2.load_previous({"provider": "aisstream", "shards": "{broken", "bbox": A, "gap_open_since": iso_ms(T0_EPOCH - 5)})
    assert ss2.add(A).feed.gaps.open_since is None  # 구역 기록이 깨졌으면 합계로 추측해 잇지 않는다


def test_restore_from_a_pre_v4_hash_needs_the_same_bbox():
    legacy = {
        "provider": "aisstream",
        "bbox": f"{A};{B}",
        "gap_open_since": iso_ms(T0_EPOCH - 60),
        "gap_reason": "ais process stopped",
    }
    ss, _, _ = _set()
    ss.load_previous(legacy)
    assert ss.add(A).feed.gaps.open_since is None  # 구독 영역이 다르면 그 공백이 아니다
    ss2, _, _ = _set()
    ss2.load_previous(legacy)
    one = ss2.add(f"{A};{B}")
    assert one.feed.gaps.open_since == T0_EPOCH - 60 and one.feed.gaps.scope == f"{A};{B}"
    assert ss2.add(f"{A};{B}").feed.gaps.open_since is None  # 구역 하나에만
    # fixture(구역 없음)는 bbox 와 상관없이 잇는다(v4 이전과 같다)
    ss3, _, _ = _set("fixture")
    ss3.load_previous({"provider": "fixture", "bbox": "fixture:f.jsonl", "last_msg_at": iso_ms(T0_EPOCH - 10)})
    fx = ss3.add(None)
    assert fx.feed.gaps.open_since == T0_EPOCH - 10 and fx.feed.gaps.scope is None


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        (None, None),
        ("", None),
        ("nope", []),
        ('{"scope": "x"}', []),
        ('[1, {"scope": null}, {"scope": 5}, {"scope": "a"}]', [{"scope": None}, {"scope": "a"}]),
        (json.dumps([{"scope": str(i)} for i in range(5)]), [{"scope": "0"}, {"scope": "1"}, {"scope": "2"}]),
    ],
)
def test_previous_shards_parsing(raw, want):
    assert previous_shards(raw) == want


def test_removed_shard_keeps_counts_and_unsent_gaps_but_drops_its_open_gap():
    ss, wall, _ = _set()
    a, b = ss.add(A), ss.add(B)
    _receiving(a, A, T0_EPOCH + 1)
    _receiving(b, B, T0_EPOCH + 1)
    b.feed.on_disconnected("server closed (1006)")
    b.feed.on_subscribed(B, deflate=True)
    b.feed.on_message(T0_EPOCH + 9)  # 공백 닫힘(아직 발행 전)
    b.feed.on_disconnected("server closed (1011)")  # 다시 열림
    closed = b.feed.gaps.last
    assert closed is not None and closed["scope"] == B and len(b.feed.gaps.pending) == 1
    ss.begin_closing(b)
    assert [s.feed for s in ss.active] == [a.feed] and ss.bbox == A and ss.connected  # 상태에서는 빠졌다
    assert ss.msgs_total == 3 and ss.gaps_pending == 1  # 누적 수·보낼 공백은 남는다
    assert ss.gap_open() is None  # 없애는 구역의 열린 공백은 합계에 넣지 않는다
    ss.retire(b)
    assert not ss.closing and ss.msgs_total == 3 and ss.sessions_ended == 2
    assert list(ss.retired_pending) == [closed] and ss.pending_queues()[0] is ss.retired_pending
    assert ss.last_gap() == closed and not b.feed.gaps.pending


def test_on_stopped_opens_a_gap_per_shard_with_its_scope():
    ss, _, _ = _set()
    a, b = ss.add(A), ss.add(B)
    _receiving(a, A, T0_EPOCH + 1)
    _receiving(b, B, T0_EPOCH + 2)
    ss.on_stopped()
    assert ss.state == "stopped" and ss.gap_open() == (T0_EPOCH + 1, "ais process stopped")
    assert [(s.feed.gaps.open_since, s.feed.gaps.scope) for s in ss.active] == [(T0_EPOCH + 1, A), (T0_EPOCH + 2, B)]
