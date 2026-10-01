"""공급자 폴백 체인(FR-16): 1순위 3회 연속 실패 → 다음 순위, 10분 뒤 복귀 시도. 전환은 provider_switch 이벤트로 기록.

관심 지역에서는 '3회 연속 실패' 쉼도 차단이 아니라 선호도다(운영 로그 2026-09-30 — 아래 429 미룸과 같은 규칙): 쓸 수 있는 공급자가 하나도 없으면
(미룸 중인 공급자도 없으면) 쉬는 공급자를 작업 주기 그대로 다시 시도한다(여럿이면 오래 시도하지 않은 것부터). 다시 시도가 실패해도 쉼 끝을 늘리지
않고 새 '3회'를 세지 않는다(WARN 되풀이 없음) — 답하면(succeeded) 쉼을 끝낸다. 운영자가 끈 · 일시정지 · 설정 안 된 공급자는 다시 시도하지 않는다.
다시 시도가 받은 짧은 쉼(429 · 호출 제한기 쿨다운 · 예산)은 실패 쉼 위에 얹힌다 — 그동안은 부르지 않고, 끝나면 남은 실패 쉼이 이어진다(짧은 쉼이
600 s 쉼을 덮어 줄이지 않는다 — 리뷰 2026-09-30: 전에는 다시 시도의 429 가 쉼 끝을 60 s 로 바꿔 그 뒤 정상 공급자로 골랐다 · '쉼 끝' 회복).
전에는 adsb_fi 가 연결 실패(SSLEOFError) 3번으로 10분 쉬는 동안 adsb_lol 까지 429 로 쉬면 관심 지역에 공급자가 없었다 — 12:16:22 → 12:21:22 ·
12:22:18 → 12:24:50 KST, 합 452 s(쉼 600 s · 429 쉼 300 s 와 로그 시각으로 계산) — 그동안 adsb_fi 가 풀려도 12:24:50 까지 부르지 않았다.
전세계 체인은 다시 시도하지 않는다(FR-16 의 10분 쉼 그대로 — 리뷰 2026-09-30): 전세계를 지원하는 공급자는 OpenSky 하나이고 호출마다 크레딧을
쓴다(실패한 호출도 예산에 남는다 — 연결 실패만 돌려준다). 전세계는 선택 기능이다(ADR-009).

공급자 없음은 이름 붙인 상태다 — 일하는 공급자가 없다: 고를 공급자가 없거나, 쉬는 공급자를 다시 시도하는 중이다(리뷰 2026-09-30: 다시 시도를
공급자로 적으면 운영 배지가 초록 'region: adsb_fi' 로 그 상태를 가렸다). 처음 없어진 순간 set_none(시작 시각 · 건너뛴 까닭 · 체인 상태로 정해지는
가장 이른 풀림 시각 — 운영자가 켜야 하거나 설정이 없어 때를 모르면 없음 · 다시 시도하는 공급자 — 없으면 빈 값)과 전환 기록(쓰던 공급자 → none)을
남긴다. 다시 시도하는 공급자가 바뀌면 필드를 다시 쓴다(시작 시각은 그대로). 끝나는 때: 정상 후보를 고르거나(pick) 다시 시도한 공급자가 답했다
(succeeded) — none → 공급자 전환('recovery — 공급자 없음 N s 끝 · …')과 set_active(없음 필드를 비운다). 작업이 꺼지면(stand_down) 필드만 비운다.
쓰던 공급자 이름(wakeline:active 의 {job})은 마지막으로 쓴 것으로 남는다 — 지금 상태는 {job}_none_* 가 말한다.
이 필드 쓰기(set_none · set_active · clear_none)가 Redis 오류로 실패하면(ProviderStatus 가 삼키고 False) 다음 주기에 다시 쓴다 — 공백마다 한 번만
쓰므로, 전에는 쓰기 한 번이 실패하면 공백 내내(최대 10분) 운영 배지가 초록 · 상태 바에 '공급자 없음' 없음, 회복 쓰기가 실패하면 빨간 배지가 다음
전환까지 남았다(리뷰 2026-09-30). 전환 기록(switch_event)은 다시 쓰지 않는다(한 번의 사건).

429 이력(R-17): 429 가 RATE_LIMIT_RESET_S(15분) 안에 되풀이되면 백오프(최대 300 s)가 끝난 뒤에도 그 공급자를 한동안
뒤로 미룬다(hold: 10 → 20 → 40 → 60 → 120 → 240 → 360분, 상한 6 h). 그동안 다음 순위가 같은 주기로 맡는다. hold 는 차단이 아니라
선호도라서, 다른 공급자가 하나도 없으면 백오프가 끝난 공급자를 그대로 쓴다. 15분 동안 429 없이 쓰이면 단계가 초기화된다. 단계는
STAGE_MAX(8 — 쉼·미룸이 모두 가장 긴 값인 단계)에서 멈춘다. 공급자의 실제 한도 수치는 모르므로 호출 속도를 추정해 정하지 않는다.
사다리의 120 · 240 · 360분은 선택값이다(2026-09-29 관찰: adsb.lol 이 60분 미룸이 끝나고 약 1분 만에 다시 429 — ADR-011).

체인은 작업(region·global)마다 따로지만, 공급자 객체에 붙은 paused_until(UTC)은 두 체인이 함께 본다
(예: OpenSky 남은 크레딧이 예비분 아래로 내려가면 자정까지 어느 체인도 쓰지 않는다).
상태 기록(set_active·switch_event·is_disabled)은 ProviderStatus 가 Redis 오류를 삼키므로 선택을 막지 않는다.

재시작(R-17 보존): store(ChainStateStore)를 주면 429 이력(단계·마지막 429·쉼 끝·미룸 끝·조용함 기준)을 429 마다 Redis 에 벽시계 epoch 초로
남기고(persist), 첫 선택 때 읽어 단조 시계로 바꿔 되살린다. 지난 기록(expires_at)·형식이 틀린 기록·상한보다 먼 미래를 가리키는 기록은
버린다. Redis 가 안 되면 메모리 이력만 쓴다(선택을 막지 않는다). 되살린 쉼·미룸의 전환 사유에는 '(재시작 전 기록)'을 붙인다.
읽기가 실패하면 읽힐 때까지 선택·429 마다 다시 읽는다. 그동안 받은 429 는 메모리에만 적고 저장하지 않는다(읽지 못한 기록을 1단계로
덮지 않게) — 읽기가 되면 저장된 단계에 이어 센 것으로 맞추고(되살리기가 제때 됐을 때와 같게) 저장한다.

전환 사유(set_active·switch_event 에 같은 글, 가린 뒤 REASON_MAX 자): 무엇을 왜 건너뛰었는지·왜 돌아왔는지를 적는다.
  "fallback — adsb_lol 429 쉼(60 s)" · "fallback — adsb_lol 429 반복 → 20분 뒤로 미룸" · "fallback — adsb_lol 3회 연속 실패(10분 쉼)" ·
  "fallback — adsb_lol 운영자 끔" · "fallback — adsb_lol 일시정지(크레딧/예산)" · "recovery — adsb_lol 쉼 끝(1순위 복귀)" ·
  "order — 공급자 순서 변경(aircraft_providers — adsb_fi 1순위)"(운영 설정의 순서가 바뀌어 고른 공급자 — 지난 선택 때 건너뛰지 않았다) ·
  "initial" (처음 고른 것이 1순위가 아니면 "initial — <건너뛴 공급자> <사유>"). 순위는 이 작업 범위(관심 지역·전세계)를 지원하는 공급자 사이의 순서다.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from wakeline_collector.chain_state import (
    RATE_LIMIT_RESET_S,
    REASON_MAX,
    VERSION,
    ChainState,
    Choice,
    backoff_s,
    dur,
    parse_saved,
)
from wakeline_collector.chain_store import ChainStateStore
from wakeline_collector.masking import mask
from wakeline_collector.status import ProviderStatus

log = logging.getLogger("fallback")


class ProviderChain(ChainState):
    def __init__(
        self,
        job: str,
        providers: dict[str, Any],
        status: ProviderStatus,
        fail_threshold: int = 3,
        cooldown_s: float = 600.0,
        *,
        store: ChainStateStore | None = None,
    ):
        # 단조 시계는 부를 때마다 이 모듈의 time 에서 읽는다(시험이 fallback.time 을 바꿔 끼운다)
        super().__init__(job, providers, fail_threshold, cooldown_s, mono=lambda: time.monotonic())
        self._store = store
        self._restored = store is None
        self._status = status
        self._disabled: frozenset[str] | None = None  # 운영자가 끈 공급자 — 이 주기의 pick 이 읽었다(_evaluate)

    async def _read_disabled(self, order: list[str], need_global: bool) -> frozenset[str]:
        """이 범위의 설정된 후보 가운데 운영자가 끈 공급자 — 후보마다 is_disabled 를 한꺼번에 기다린다(Redis 가 멈춰도 AUX_TIMEOUT_S 한 번 —
        전에는 후보마다 차례로 기다렸다). Redis 오류면 ProviderStatus 가 마지막으로 읽은 값을 준다(전과 같다)."""
        names = [n for n in self._candidates(order, need_global) if getattr(self._providers[n], "configured", True) is not False]
        flags = await asyncio.gather(*(self._status.is_disabled(n) for n in names))
        self._disabled = frozenset(n for n, off in zip(names, flags, strict=True) if off)
        return self._disabled

    async def _evaluate(self, order: list[str], need_global: bool, *, fresh: bool = True) -> Choice:
        """chain_state.choose — 처음 한 번은 저장된 429 이력을 되살린다. 운영자 끔은 주기마다 한 번 읽는다: pick(fresh)이 읽고, 같은 주기의
        peek 은 그것을 다시 쓴다(읽은 적이 없으면 읽는다). 전에는 pick · peek 마다 후보마다 HGET 을 차례로 기다렸다(429 주기에 3번 —
        tests/perf/chain_disabled_reads.py)."""
        if not self._restored:
            await self._restore()
        disabled = self._disabled
        if fresh or disabled is None:
            disabled = await self._read_disabled(order, need_global)
        return self.choose(order, need_global, disabled, datetime.now(UTC))

    async def peek(self, order: list[str], *, need_global: bool = False) -> str | None:
        """다음 pick 이 고를 공급자 이름(상태·사유를 기록하지 않는다). 로그에 '다음에 무엇을 하는지'를 적을 때 쓴다 — 운영자 끔은 이 주기의 pick 이
        읽은 것으로 본다."""
        return (await self._evaluate(order, need_global, fresh=False)).name

    async def pick(self, order: list[str], *, need_global: bool = False) -> Any | None:
        """이번 주기에 부를 공급자(없으면 None). 쉬는 공급자를 다시 시도하는 것(mode "probe")도 돌려주지만 상태는 '공급자 없음'이다 —
        그 공급자가 답하면(succeeded) 끝난다."""
        c = await self._evaluate(order, need_global)
        ranked = self._candidates(order, need_global)
        reordered = self._ranked is not None and ranked != self._ranked
        prev_skipped = self._skipped_prev
        self._ranked, self._skipped_prev = ranked, frozenset(n for n, _k, _w in (c.full or c.skipped))
        for n, kind, _why in c.skipped:
            self._last_skip[n] = kind
        if c.name is None:
            await self._enter_none(c.skipped, None)
            return None
        if c.mode == "probe":
            self._probed_at[c.name] = time.monotonic()
            self._last_skip[c.name] = "down"
            await self._enter_none(list(c.full), c.name)  # 일하는 공급자가 없다 — 쉬는 c.name 을 다시 시도하는 중
            return self._providers[c.name]
        if self._none_since is not None or self._current != c.name:
            # 지난 선택 때 건너뛰지 않았는데 순서가 바뀌어 이번에 고른 공급자 — 쉬었다 돌아온 것이 아니다(리뷰 2026-09-30 밤)
            by_order = reordered and c.name not in prev_skipped
            await self._use(c.name, self._reason(c, ranked, by_order))
        elif not self._state_saved:  # 앞선 set_active 가 Redis 오류로 실패했다 — 같은 값(그때 · 까닭)으로 다시 쓴다
            saved = await self._status.set_active(self.job, c.name, reason=self._active_reason, since=self._active_at)
            self._state_saved = saved is not False
        return self._providers[c.name]

    async def succeeded(self, name: str) -> float | None:
        """name 이 답했다(record_success). 공급자 없음 동안 다시 시도하던 공급자면 그 공백을 끝낸다 — none → name 전환 · set_active(없음 필드를
        비운다). 돌려주는 값: 끝낸 공백의 길이(초) — 끝낸 공백이 없으면 None."""
        self.record_success(name)
        if self._none_since is None or self._none_retry != name:
            return None
        gap = time.monotonic() - self._none_since
        await self._use(name, f"recovery — 공급자 없음 {dur(round(gap))} 끝 · {name} 다시 시도 성공")
        return gap

    async def stand_down(self) -> bool:
        """작업이 꺼졌다(운영 설정 — 예: 전세계 끔): 공급자 없음 상태를 버리고 wakeline:active 의 {job}_none_* 를 비운다 — 꺼진 작업이 '공급자 없음'
        으로 남지 않게(리뷰 2026-09-30). 앞선 프로세스가 남긴 값도 지운다(부르는 쪽이 꺼진 동안 비울 때까지 부른다). 돌려주는 값: 비웠는가."""
        self._none_since = self._none_at = self._none_retry = None
        self.none_reason, self.none_next = "", None
        return await self._status.clear_none(self.job) is not False

    async def _enter_none(self, skipped: list[tuple[str, str, str]], retry: str | None) -> None:
        """공급자 없음의 시작(같은 공백에는 한 번): set_none(시작 · 까닭 · 가장 이른 풀림 시각 · 다시 시도하는 공급자)과 전환 기록(쓰던 공급자 → none).
        같은 공백 안에서 다시 시도하는 공급자가 바뀌면(생김 · 바뀜 · 없어짐) 필드만 다시 쓴다 — 시작 시각은 그대로, 전환 기록은 쌓지 않는다.
        앞선 set_none 이 Redis 오류로 실패했으면 이번 주기에 다시 쓴다(시작 시각 그대로)."""
        now_m, now_w = time.monotonic(), datetime.now(UTC)
        starting = self._none_since is None or self._none_at is None
        if not starting and retry == self._none_retry and self._state_saved:
            return
        if starting:
            self._none_since, self._none_at = now_m, now_w
        since = self._none_at or now_w
        self._none_retry = retry
        text = " · ".join(f"{n} {w}" for n, _k, w in skipped) or "이 범위를 지원하는 공급자가 순서에 없음"
        self.none_reason = (mask(text, None) or "")[:REASON_MAX]
        self.none_next = self._next_release(skipped, now_m, now_w)
        next_at = now_w + timedelta(seconds=self.none_next[1]) if self.none_next else None
        saved = await self._status.set_none(self.job, since=since, reason=self.none_reason, next_at=next_at, retry=retry or "")
        self._state_saved = saved is not False
        if starting and self._current is not None:
            tail = f" · {retry} 다시 시도 중" if retry else ""
            await self._status.switch_event(self.job, self._current, "none", f"none — {self.none_reason}{tail}"[:REASON_MAX])

    async def _use(self, name: str, reason: str) -> None:
        prev = "none" if self._none_since is not None else self._current
        text = (mask(reason, None) or "")[:REASON_MAX]  # 두 곳에 같은 글
        self._current = name
        self._none_since, self._none_at, self._none_retry, self.none_reason, self.none_next = None, None, None, "", None
        self._active_at, self._active_reason = datetime.now(UTC), text
        # 공급자 없음 필드도 비운다. 실패하면(Redis 오류) 다음 선택 때 같은 값으로 다시 쓴다(pick)
        self._state_saved = await self._status.set_active(self.job, name, reason=text, since=self._active_at) is not False
        if prev is not None:
            await self._status.switch_event(self.job, prev, name, text)

    async def on_rate_limited(self, name: str) -> float:
        """429 를 적고 저장한다. 반환값은 쉬는 시간(초). 저장된 이력을 아직 읽지 못했으면 먼저 다시 읽는다 —
        읽지 못한 채 적으면 재시작 전 단계를 모르고 1단계부터 센다."""
        if not self._restored:
            await self._restore()
        self._record_429(name, time.monotonic())
        await self.persist(name)  # 여기서야 읽기가 되면 저장된 단계에 이어 센 값으로 맞춰진다
        return backoff_s(self._rate_limited[name])

    async def persist(self, name: str) -> None:
        """name 의 429 이력을 저장한다(429 를 기록한 뒤 부른다). 저장소가 없거나 이력이 없으면 아무것도 하지 않는다.
        저장된 이력을 아직 읽지 못했으면 먼저 읽고(되면 맞춰서 저장한다), 여전히 못 읽으면 쓰지 않는다 — 읽지 못한 기록을 덮지 않는다.
        Redis 오류는 저장소가 삼킨다(메모리 이력으로 계속)."""
        if self._store is None or not self._rate_limited.get(name):
            return
        if not self._restored:
            await self._restore()  # 읽기가 되면 메모리에만 있던 429 이력(이 공급자 포함)을 맞춰 저장한다
            return
        await self._write(name)

    async def _write(self, name: str) -> None:
        if self._store is None:
            return
        now_m, now_w = time.monotonic(), self._store.wall()

        def wall(m: float) -> str:
            return f"{now_w + (m - now_m):.3f}"

        held = self._hold_until.get(name, 0.0) > now_m
        quiet_from = self._rl_until.get(name, now_m)
        expires_in = quiet_from + RATE_LIMIT_RESET_S - now_m
        fields = {
            "v": VERSION,
            "stage": str(self._rate_limited[name]),
            "last_429_at": wall(self._last_429.get(name, now_m)),
            "backoff_until": wall(self._backoff_until.get(name, now_m)),
            "hold_until": wall(self._hold_until[name]) if held else "",
            "hold_s": f"{self._hold_len.get(name, 0.0):.0f}" if held else "0",
            "quiet_from": wall(quiet_from),
            "expires_at": wall(quiet_from + RATE_LIMIT_RESET_S),  # 논리 만료 — 이 뒤에는 이력이 초기화된 것과 같다
            "saved_at": f"{now_w:.3f}",
        }
        await self._store.save(self.job, name, fields, ttl_s=math.ceil(expires_in))  # Redis TTL 도 같은 때

    async def _restore(self) -> None:
        """저장된 429 이력을 되살린다. Redis 오류로 읽지 못하면 그대로 두고(_restored=False) 다음 선택·429 때 다시 읽는다.
        읽기 전에 메모리에만 적은 429 는 저장된 단계에 이어 센 것으로 맞추고(_apply_saved) 저장한다."""
        store = self._store
        if store is None:
            self._restored = True
            return
        rows = await store.load(self.job, list(self._providers))
        if rows is None:
            return  # 모름 — 다음에 다시 읽는다
        self._restored = True
        now_m, now_w = time.monotonic(), store.wall()
        unsaved = [n for n, k in self._rate_limited.items() if k and not self._quiet(n, now_m)]  # 읽기 전에 메모리에만 적은 429
        for name, row in rows.items():
            saved, why = parse_saved(row, now_w)
            if saved is None:
                if why != "expired":
                    log.info("%s: %s 429 history ignored (%s)", self.job, name, why)
                await store.drop(self.job, name)
                continue
            self._apply_saved(name, saved, now_m, now_w)
        for name in unsaved:
            await self._write(name)
