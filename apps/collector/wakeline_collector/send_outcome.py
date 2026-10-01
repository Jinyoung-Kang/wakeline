"""공급자 호출 하나의 실패가 보낸 것인지 — 순수 규칙(R-65 · collector-review F7). 모든 작업(aircraft · demand · weather · OpenSky 토큰 · retry 의
돌려주기)이 이 한 판정을 쓴다. http 가 같은 이름으로 다시 내보낸다(옛 import 경로).
"""

from __future__ import annotations

from typing import Literal

from wakeline_collector.http_errors import NOT_SENT_ERRORS, NOT_SENT_LOCAL
from wakeline_collector.ratelimit import Throttled

SendOutcome = Literal["sent", "failed_before_send", "not_sent", "throttled"]


def classify_send(e: BaseException) -> SendOutcome:
    """공급자 호출 하나의 실패를 가른다 — 모든 작업이 이 판정을 쓴다(R-65 · F7: 전에는 작업마다 달라 연결 풀 대기 초과를 공급자 실패로 세고 예산을
    돌려주지 않았고, 기상 작업은 속도 상한을 공급자 실패로 적었다).
    - throttled: 속도 상한(Throttled)이 막았다 — 보내지 않았다. 예산을 돌려주고 공급자 실패가 아니다(실행 'throttled').
    - not_sent: 우리 쪽 까닭으로 보내지 않았다(NOT_SENT_LOCAL) — 예산을 돌려주고 공급자 실패가 아니다.
    - failed_before_send: 공급자 쪽이 보내기 전에 실패했다(연결 실패 · 연결 시간 초과 · 준비 호출 PreSendFailed) — 예산을 돌려주되 공급자 실패로
      센다(폴백 · 3번 쉬기가 그대로 일한다).
    - sent: 그 밖 — 보낸 것으로 센다(예산 그대로 · 공급자 실패)."""
    if isinstance(e, Throttled):
        return "throttled"
    if isinstance(e, NOT_SENT_LOCAL):
        return "not_sent"
    if isinstance(e, NOT_SENT_ERRORS):
        return "failed_before_send"
    return "sent"
