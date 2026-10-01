"""QA-312 · 낮음 — ADS-B(readsb) 호출부호 '@@@@@@@@'(6-bit 문자 0 = 값 없음 채움)를 그대로 호출부호로 쓴다.

실제 공급자 응답(fixtures/adsb_fi_region.json:43 · :60, adsb_lol_region.json:66 — "flight": "@@@@@@@@")이 api(`/api/v1/aircraft/a2fad1` → "callsign": "@@@@@@@@")와
화면(알림 목록 · 지도 라벨 · 검색 · 카드)까지 그대로 간다. 제품 규칙 "모르면 —" 와 다르고, AIS 쪽은 같은 '@' 채움을 걷어 낸다(ais/parse.py:169).
원인: normalize._str 은 공백만 걷는다(normalize.py:36-40, 호출부호 :184).
"""

from datetime import UTC, datetime

from wakeline_collector.normalize import from_readsb

NOW = datetime(2026, 9, 27, 7, 30, 0, tzinfo=UTC)


def _ac(flight: str) -> dict:
    return {
        "hex": "a2fad1",
        "flight": flight,
        "r": "N291SR",
        "t": "GLEX",
        "alt_baro": 3400,
        "gs": 211.3,
        "track": 195.09,
        "lat": 36.895209,
        "lon": 127.228486,
        "seen_pos": 5.2,
        "category": "A3",
    }


def test_qa_312_all_at_callsign_is_unknown():
    s = from_readsb(_ac("@@@@@@@@"), "adsb_fi", NOW)
    assert s is not None
    assert s.callsign is None  # '@' 채움 = 값 없음 → 화면은 '—'
