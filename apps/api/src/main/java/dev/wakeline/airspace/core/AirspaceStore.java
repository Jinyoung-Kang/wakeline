package dev.wakeline.airspace.core;

import org.springframework.stereotype.Component;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 켜진 공역 차수 하나의 불변 스냅숏(ADR-034). 읽기는 락 없음, 교체는 통째로 — 반쯤 바뀐 차수를 보지 않는다.
 * 자료가 없으면(운영자가 아직 가져오지 않음) edition null · 빈 목록이다(빈 지도와 구분해 화면이 '공역 자료 없음'을 보인다).
 * DB 읽기는 data 층(AirspaceRefresher)이 하고 여기에 넘긴다 — core 는 JDBC 를 모른다(ADR-028).
 */
@Component
public class AirspaceStore {
    public record Snapshot(AirspaceEdition edition, List<AirspaceRecord> records) {
        public static final Snapshot EMPTY = new Snapshot(null, List.of());

        /** ETag 열쇠 — 차수가 없으면 "none". */
        public String tag() { return edition == null ? "none" : edition.tag(); }
    }

    private final AtomicReference<Snapshot> current = new AtomicReference<>(Snapshot.EMPTY);

    public Snapshot snapshot() { return current.get(); }

    /** @return 바뀌었으면 true(차수 id 가 달라졌을 때) */
    public boolean replace(Snapshot next) {
        Snapshot prev = current.getAndSet(next);
        return prev.edition() == null ? next.edition() != null : next.edition() == null || prev.edition().id() != next.edition().id();
    }
}
