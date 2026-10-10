package dev.wakeline.watch;

import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.AlertStateMachine;
import dev.wakeline.weather.core.EngineEvents;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 최근에 닫힌 알림(계약 v5 §G50 · ADR-037): 관심 대상 조회가 "보지 못한 사이에 들어갔다 나온" 알림도 알리게, 엔진이 발행한 닫힘 사건을
 * {@link #WINDOW_S} 동안 메모리에 둔다(상한 {@link #MAX} — 넘으면 오래된 것부터 버린다). DB 를 읽지 않는다(요청 중 메모리만 — ADR-006).
 * 공역 shadow 의 사건은 발행되지 않으므로 여기에도 없다(알림이 아니다).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class RecentClosedAlerts {
    /** 닫힌 알림을 두는 시간 — 브라우저 30 s 조회 · 숨은 탭 · 잠깐 닫은 노트북을 덮는 값(고른 값). */
    public static final long WINDOW_S = 900;
    /** 메모리 상한 — 15분 동안의 닫힘이 이보다 많으면 오래된 것부터 버린다(전세계 SIGMET 많은 날 몇백 건). */
    static final int MAX = 5_000;
    private final Deque<Alert> closed = new ArrayDeque<>();
    private long dropped;

    @EventListener
    public void onAlerts(EngineEvents.AlertsChanged e) {
        List<Alert> add = new ArrayList<>();
        for (AlertStateMachine.Event ev : e.events()) if (!ev.alert().active()) add.add(ev.alert());
        if (add.isEmpty()) return;
        synchronized (closed) {
            closed.addAll(add);
            // 창 밖은 버림이 아니다 — 먼저 지워야 상한이 창 안의 것만 센다(QA-710). 기준은 이번에 닫힌 것 중 가장 늦은 때(엔진 시각)
            Instant latest = add.stream().map(Alert::leftAt).max(Instant::compareTo).orElseThrow();
            prune(latest.minusSeconds(WINDOW_S));
            while (closed.size() > MAX) { closed.removeFirst(); dropped++; }
        }
    }

    /** 이 항공기들의 최근 닫힌 알림(hex → 닫힌 순서). now − WINDOW_S 보다 먼저 닫힌 것은 지우며 건너뛴다. */
    public Map<String, List<Alert>> forHexes(Collection<String> hexes, Instant now) {
        Map<String, List<Alert>> out = new LinkedHashMap<>();
        if (hexes.isEmpty()) return out;
        Instant from = now.minusSeconds(WINDOW_S);
        synchronized (closed) {
            prune(from);
            for (Alert a : closed) if (!a.leftAt().isBefore(from) && hexes.contains(a.hex())) out.computeIfAbsent(a.hex(), k -> new ArrayList<>()).add(a);
        }
        return out;
    }

    /** 앞(먼저 닫힌 것)에서부터 from 보다 먼저 닫힌 것을 지운다. closed 를 잡고 부른다. */
    private void prune(Instant from) {
        while (!closed.isEmpty() && closed.peekFirst().leftAt().isBefore(from)) closed.removeFirst();
    }

    /** 상한 때문에 버린 수(창이 짧아졌는지 알 수 있게 — 지표 대신 응답에). */
    public long dropped() { synchronized (closed) { return dropped; } }
}
