package dev.skywx.persist;

import dev.skywx.domain.AircraftState;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** aircraft 정적 정보(등록·기종) — 첫 관측 시 upsert, last_seen 갱신은 hex 당 1분에 1회로 제한(FR-29 캐시). */
@Repository
public class AircraftRepository {
    private final JdbcClient db;
    private final Map<String, Long> lastTouched = new ConcurrentHashMap<>();

    public AircraftRepository(JdbcClient db) { this.db = db; }

    public void touch(Collection<AircraftState> states) {
        long now = System.currentTimeMillis();
        List<AircraftState> due = states.stream().filter(s -> now - lastTouched.getOrDefault(s.hex(), 0L) > 60_000).toList();
        if (due.isEmpty()) return;
        try {
            for (AircraftState s : due) {
                db.sql("""
                        INSERT INTO aircraft (hex, registration, type_code, category, source, first_seen, last_seen)
                        VALUES (:hex, :reg, :type, :cat, :src, :seen, :seen)
                        ON CONFLICT (hex) DO UPDATE SET last_seen = EXCLUDED.last_seen,
                          registration = COALESCE(EXCLUDED.registration, aircraft.registration),
                          type_code = COALESCE(EXCLUDED.type_code, aircraft.type_code),
                          category = COALESCE(EXCLUDED.category, aircraft.category)""")
                        .param("hex", s.hex()).param("reg", s.registration()).param("type", s.typeCode()).param("cat", s.category())
                        .param("src", s.provider()).param("seen", Sql.ts(Instant.now())).update();
                lastTouched.put(s.hex(), now);
            }
        } catch (RuntimeException e) {
            // DB 장애는 실시간 경로를 막지 않는다
        }
        if (lastTouched.size() > 100_000) lastTouched.clear();
    }

    public Map<String, Object> find(String hex) {
        return db.sql("SELECT hex, registration, type_code, category, source, first_seen, last_seen FROM aircraft WHERE hex = :hex")
                .param("hex", hex).query().listOfRows().stream().findFirst().map(m -> Map.copyOf(m)).orElse(null);
    }

    public List<Map<String, Object>> search(String prefix, int limit) {
        return db.sql("""
                SELECT hex, registration, type_code, last_seen FROM aircraft
                WHERE upper(hex) LIKE :p OR upper(registration) LIKE :p ORDER BY last_seen DESC LIMIT :n""")
                .param("p", prefix + "%").param("n", limit).query().listOfRows();
    }
}
