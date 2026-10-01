"""수신 진단 — keepalive 1011(ping 시간 초과) 끊김의 원인을 다음번에 가릴 수 있게 재는 값(ADR-014 부록 C).

1011 을 내는 기제는 셋이다(tests/test_ais_keepalive.py 로 재현):
  1. 이벤트 루프 멈춤(루프 위 CPU 작업 · 프로세스가 멈춤) — ping 이 나가 있는 동안 시간 초과보다 길면 1011 이 날 수 있다(버퍼 크기와 상관없다).
     늘 나지는 않는다: 멈춤이 끝난 뒤 pong 을 읽는 콜백과 시간 초과 콜백의 순서에 달린다(연결마다 다를 수 있다). → LoopLag(loop_lag_max_s · loop_stalls_total)
  2. 소켓을 읽는 코드가 멈춤 — websockets 수신 버퍼가 max_queue 를 넘으면 읽기를 멈춰 pong 도 못 읽는다. 우리 수신 태스크는 기다리지 않으므로
     곧 비운다. 버퍼가 상한을 넘는 것 자체는 결함이 아니다 — 한 번 읽기에 프레임이 많이 든 묶음(공급자 적체 해소 · 망이 잠깐 끊겼다 이어짐)이나 루프
     멈춤 뒤에 잠깐 넘는다(test_ais_diag). → 구역별 ws 수신 버퍼 깊이(ws_queue_max, client._read) · 원문 대기열 머문 시간(queue_wait_max_s, RawQueue)
  3. 서버·망이 pong 을 늦게 보냄(공급자 쪽 연결별 적체 — VERIFICATION #17) → 구역별 keepalive 왕복(ping_rtt_max_s) · 공급자 지연(lag_p50_s)

모두 '최근 창의 최댓값' 이다. 표본이 없으면 None(상태 해시 "" — 모름, 0 으로 채우지 않는다).

고른 값(잰 값이 아니다):
- DIAG_WINDOW_S 60 s: 최근 최댓값의 창. 처음에는 keepalive 한 번(ping 20 s 간격 + 시간 초과 20 s = 40 s)을 덮게 골랐다. 시간 초과를 40 s 로 올린 뒤
  (ADR-014 부록 C 개정 2026-09-30 오후) 한 번은 20 + 40 = 60 s 로 창과 같다 — 왕복 표본은 pong 이 온 순간 남으므로 40 s 늦은 pong 도 창에 60 s 남는다.
  상태 해시 쓰기(5 s)를 몇 번 놓쳐도 남는다.
- BUCKET_S 5 s: 창을 12칸으로 나눈다 — 값마다 칸 13개(시작 시각·최댓값)만 들고 있다(메모리 상한). 창 경계는 칸 단위라 최대 65 s 까지 본다.
- LOOP_TICK_S 0.5 s: 루프 지연 표본 간격(sleep 이 늦게 깬 만큼이 지연). 1 s 멈춤을 놓치지 않고, 깨우는 비용은 초당 2번.
- LOOP_STALL_S 1.0 s: loop_stalls_total 로 세는 지연. 우리 코드의 루프 위 작업은 잰 최악이 약 0.1 s(M1, 선박 2만 척을 한 번에 발행하는
  꺼내기 56 ms + 인코딩 56 ms · 정리 512건 묶음 20 ms — 2026-09-30 측정) — 그 10배.
- LOOP_WARN_S 5.0 s: WARN 으로 알리는 지연 — 처음 고를 때 keepalive 시간 초과 20 s 의 1/4. 시간 초과를 40 s 로 올린 뒤에도 그대로 둔다(1011 문턱이 아니라
  루프 건강 신호다 — 잰 최악 0.1 s 의 50배). WARN_EVERY_S 60 s 에 1번까지(수는 모두 센다 — 로그 화면이 한 번의
  긴 멈춤을 되풀이로 덮지 않게).
이 고른 값들은 상태 해시(loop_tick_s · loop_stall_s · loop_warn_s · loop_warn_every_s · diag_window_s)에 실어 읽는 쪽이 들고 있지 않게 한다.
WindowMax · LoopLag 와 고른 값은 수집기와 함께 쓰는 diag 모듈에 있고 여기서 다시 내보낸다(LoopLag 은 ais 의 WARN 글 · 로거를 붙인 것).
"""

from __future__ import annotations

import logging
from typing import Any

from wakeline_collector.diag import BUCKET_S as BUCKET_S
from wakeline_collector.diag import DIAG_WINDOW_S as DIAG_WINDOW_S
from wakeline_collector.diag import LOOP_STALL_S as LOOP_STALL_S
from wakeline_collector.diag import LOOP_TICK_S as LOOP_TICK_S
from wakeline_collector.diag import LOOP_WARN_S as LOOP_WARN_S
from wakeline_collector.diag import WARN_EVERY_S as WARN_EVERY_S
from wakeline_collector.diag import LoopLag as SharedLoopLag
from wakeline_collector.diag import WindowMax as WindowMax

log = logging.getLogger("ais.diag")

# ais 의 루프 멈춤 WARN 이 덧붙이는 말 — 그동안 무엇이 멈췄고 무엇이 날 수 있는지(위 1)
STALL_CONTEXT = "nothing was read meanwhile; a keepalive ping outstanding across a stall longer than its timeout can end in 1011"


class LoopLag(SharedLoopLag):
    """ais 프로세스의 루프 지연(diag.LoopLag) — WARN 은 1011 맥락을 붙여 ais.diag 로거로(로그 지문이 공유 전과 같다)."""

    def __init__(self, **kw: Any) -> None:
        super().__init__(label="ais", context=STALL_CONTEXT, logger=log, **kw)
