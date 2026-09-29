"""리뷰가 찾은 색인의 틀린(또는 막힌) '기록 없음' 경로 재현(ADR-022 개정 · 2026-09-29 리뷰).

api 는 10곳이 모두 30일 창을 덮고(covered_from ≤ 창 첫날 · covered_to = 오늘) 2시간 안에 갱신했을 때만 'none' 이라 말한다(PortCallReader.summarize).
그러니 수집기는 (1) 범위가 '완전' 하다고 적은 날에서 기록을 잃으면 안 되고, (2) 한 날의 문제로 색인 전체나 한 항만청을 멈추면 안 된다.
  1. 한 판(최종) 안에 입항 시각이 둘 — 판 이름만 남고 시각은 NULL 인 행이 V15 CHECK port_call_revision_needs_time 에 걸려 그 날 트랜잭션이 되돌려졌고,
     작업은 그것을 DB 장애로 보아 모든 항만청을 60 s 씩 멈추기를 끝없이 되풀이했다(같은 날을 다시 받으므로).
  2. 저장된 행이 1–2개인 날(포항 · 목포에서 흔하다)은 한 번의 빈 응답(resultCode 00 · totalCount 0)으로 바로 지워졌다 — 범위는 완전 · 새것 그대로라
     api 가 그 선박에 'none' 을 말했다.
  3. 색인할 수 없는 item 하나(입항횟수 없음 등)가 있는 날에서 그 항만청의 꼬리가 멈췄다 — 그 뒤의 날은 받지 않아 새 입출항이 색인되지 않았다.
가짜 DB(portcall_index_fakes.FakeIndexDb)는 V15 의 행 CHECK 를 실제와 같게 지킨다.
"""

from __future__ import annotations

import copy
from datetime import date, timedelta

import httpx
from portmis_observed import ObservedPortMis, empty_bytes, synthetic_item
from test_portcalls_index_job import CODES, NOW, _drain, _job, _row_for

from wakeline_collector.jobs import portcalls_index as ix


class FlakyOnce(ObservedPortMis):
    """확인한 대로 답하되, flake 로 정한 (항만청, 날짜) 요청 한 번만 실제 빈 응답(resultCode 00 · totalCount 0)을 준다."""

    def __init__(self, items):
        super().__init__(items)
        self.flake: tuple[str, str] | None = None

    def __call__(self, req: httpx.Request) -> httpx.Response:
        q = dict(httpx.QueryParams(req.url.query))
        if self.flake is not None and (q["prtAgCd"], q["sde"]) == self.flake:
            self.flake = None
            self.requests.append(q)
            return httpx.Response(200, content=empty_bytes(), headers={"content-type": "text/xml;charset=UTF-8"})
        return super().__call__(req)


async def test_two_times_in_one_revision_neither_keep_a_timeless_revision_nor_stall_the_index():
    fake = ObservedPortMis([])
    job, db, _r, clock = _job(direct=fake)
    await _drain(job)
    amb = synthetic_item(pa="020", clsgn="D7AMB", entry="2026-09-29T21:00:00+09:00", count="009")
    details = amb.find("details")
    assert details is not None
    second = copy.deepcopy(details[0])  # 최종 입항 신고를 하나 더 — 다른 시각
    second.find("etryptDt").text = "2026-09-29T21:30:00+09:00"  # type: ignore[union-attr]
    details.append(second)
    uls = synthetic_item(pa="820", pa_name="울산", clsgn="D7ULS", entry="2026-09-29T22:30:00+09:00", count="004")
    fake.items += [amb, uls]
    clock.advance(hours=1)
    await _drain(job)
    assert db.refused == []  # DB 가 되돌린 날이 없다
    row = _row_for(db, "D7AMB")
    assert (row.entry_at, row.entry_revision) == (None, None)  # 고르지 않았다 — 판 이름만 남기지 않는다
    assert db.by_call_sign("D7ULS")  # 다른 항만청은 계속
    assert all(db.cov[c].refreshed_at == clock.now() for c in CODES)
    assert not any("database write failed" in (r.get("error_text") or "") for r in db.runs)


async def test_one_empty_answer_never_deletes_a_day_with_a_single_stored_row():
    fake = FlakyOnce([synthetic_item(pa="700", pa_name="포항", clsgn="D7POH", entry="2026-09-28T09:00:00+09:00", count="002")])
    job, db, _r, clock = _job(direct=fake)
    await _drain(job)
    assert db.by_call_sign("D7POH")
    fake.flake = ("700", "20260928")  # 다음 한 번만 빈 응답
    clock.advance(hours=1)
    await _drain(job)
    assert db.by_call_sign("D7POH")  # 한 번의 빈 응답으로는 지우지 않는다
    assert db.cov["700"].refreshed_at == NOW  # 포항 꼬리 갱신은 끝나지 않았다(범위가 이 빈 응답으로 '완전 · 새것' 이 되지 않는다)
    clock.advance(seconds=ix.FAIL_BACKOFF_S[0])
    await _drain(job)
    assert db.by_call_sign("D7POH") and db.cov["700"].refreshed_at == clock.now()  # 다시 받으니 있다 — 지우지 않은 것이 맞았다
    # 정말로 철회된 신고: 빈 응답 둘이 EMPTY_CONFIRM_S 넘게 떨어져 같을 때 지운다
    fake.items[:] = []
    clock.advance(hours=1)
    await _drain(job)
    assert db.by_call_sign("D7POH")
    clock.advance(seconds=ix.EMPTY_CONFIRM_S)
    await _drain(job)
    assert db.by_call_sign("D7POH") == []


async def test_an_unindexable_item_neither_freezes_its_authority_nor_lets_its_day_count_as_complete():
    fake = ObservedPortMis([])
    job, db, _r, clock = _job(direct=fake, limit=10**7)
    await _drain(job)
    bad = synthetic_item(pa="020", clsgn="D7BAD", entry="2026-09-30T09:00:00+09:00", count="001")
    bad.remove(bad.find("etryptCo"))  # type: ignore[arg-type] — 자연 키를 만들 수 없다
    same_day = synthetic_item(pa="020", clsgn="D7SAM", entry="2026-09-30T11:00:00+09:00", count="002")
    later = synthetic_item(pa="020", clsgn="D7NEW", entry="2026-10-02T10:00:00+09:00", count="007")
    fake.items += [bad, same_day, later]
    sent = len(fake.requests)
    for _h in range(24 * 4):  # 나흘을 한 시간씩
        clock.advance(hours=1)
        await _drain(job)
    today = date(2026, 10, 3)  # 13:00Z = 22:00 KST
    busan = db.cov["020"]
    assert (busan.covered_to, busan.refreshed_at) == (today, clock.now())  # 범위는 그 날을 넘어 오늘까지 · 꼬리 갱신도 계속
    assert busan.holes == frozenset({date(2026, 9, 30)})  # 그 날은 빈 곳 — api 는 'none' 을 말하지 않는다
    assert db.by_call_sign("D7NEW")  # 그 뒤의 입출항도 색인됐다
    assert _row_for(db, "D7SAM").listed_date == date(2026, 9, 30)  # 그 날의 키가 있는 기록은 둔다(찾을 수 있다)
    assert db.by_call_sign("D7BAD") == []  # 키를 지어내지 않는다
    bad_day = [q for q in fake.requests[sent:] if (q["prtAgCd"], q["sde"]) == ("020", "20260930")]
    assert len(bad_day) <= 24 * 4  # 그 날은 한 시간에 많아야 한 번(꼬리 갱신 · 빈 곳 다시 받기) — 60 s 마다 되풀이하지 않는다
    assert all(db.cov[c].holes == frozenset() for c in CODES[1:])
    for c in CODES[1:]:
        assert db.cov[c].covered_to == today and db.cov[c].refreshed_at == clock.now()
    assert db.cov["020"].covered_from <= today - timedelta(days=30)
