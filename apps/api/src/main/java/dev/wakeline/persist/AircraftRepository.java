package dev.wakeline.persist;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.platform.data.Sql;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * aircraft 정적 정보(등록·기종·분류) + last_seen(FR-29 캐시).
 * 항적 저장 스레드(TrackWriter)에서만 쓴다 — 스트림 소비 스레드(실시간 경로)는 DB 를 기다리지 않는다(PERF-1·REL-9).
 * 쓰기 대상: 처음 보는 hex, 등록·기종·분류가 새로 알려졌거나 바뀐 hex, last_seen 을 1분 넘게 안 쓴 hex. 한 묶음을 SQL 한 문장으로 쓴다.
 */
@Repository
public class AircraftRepository {
    /** last_seen 은 hex 당 1분에 한 번까지만 쓴다. */
    static final long LAST_SEEN_INTERVAL_MS = 60_000;
    /** 한 문장에 싣는 최대 행 수(전세계 스냅샷 ~9,000행이면 두 문장). */
    static final int MAX_ROWS_PER_STATEMENT = 5_000;
    static final int CACHE_MAX = 200_000;

    private final JdbcClient db;
    private final ObjectMapper json;
    /** hex → 마지막으로 DB 에 쓴 정적 정보와 그 시각. 쓰기에 성공한 뒤에만 갱신한다. */
    private final Map<String, Written> written = new ConcurrentHashMap<>();

    record Written(String registration, String typeCode, String category, long atMs) {}

    public AircraftRepository(JdbcClient db, ObjectMapper json) {
        this.db = db;
        this.json = json;
    }

    /** 이번에 써야 하는 상태(hex 당 하나, 마지막 것). */
    List<AircraftState> due(Collection<AircraftState> states, long nowMs) {
        Map<String, AircraftState> byHex = new LinkedHashMap<>();
        for (AircraftState s : states) byHex.put(s.hex(), s);
        List<AircraftState> out = new ArrayList<>();
        for (AircraftState s : byHex.values()) {
            Written w = written.get(s.hex());
            if (w == null || nowMs - w.atMs() >= LAST_SEEN_INTERVAL_MS || learned(w, s)) out.add(s);
        }
        return out;
    }

    /** 등록·기종·분류 중 새로 알려졌거나 바뀐 것이 있는가(모르는 값 null 은 기존 값을 지우지 않으므로 변화가 아니다). */
    private static boolean learned(Written w, AircraftState s) {
        return (s.registration() != null && !Objects.equals(s.registration(), w.registration()))
                || (s.typeCode() != null && !Objects.equals(s.typeCode(), w.typeCode()))
                || (s.category() != null && !Objects.equals(s.category(), w.category()));
    }

    /**
     * 정적 정보 upsert. 쓸 것이 있으면 최대 5,000행씩 한 문장(jsonb_to_recordset)으로 쓴다. 예외는 호출자(항적 스레드)가 처리한다.
     * @return 쓴 행 수
     */
    public int touch(Collection<AircraftState> states) {
        long now = System.currentTimeMillis();
        List<AircraftState> due = due(states, now);
        for (int i = 0; i < due.size(); i += MAX_ROWS_PER_STATEMENT) {
            List<AircraftState> chunk = due.subList(i, Math.min(due.size(), i + MAX_ROWS_PER_STATEMENT));
            List<Map<String, Object>> rows = new ArrayList<>(chunk.size());
            for (AircraftState s : chunk) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("hex", s.hex());
                r.put("reg", s.registration());
                r.put("type", s.typeCode());
                r.put("cat", s.category());
                r.put("src", s.provider());
                r.put("seen", s.seenAt().toString());
                rows.add(r);
            }
            db.sql("""
                    INSERT INTO aircraft (hex, registration, type_code, category, source, first_seen, last_seen)
                    SELECT t.hex, t.reg, t.type, t.cat, t.src, t.seen, t.seen
                    FROM jsonb_to_recordset(:rows::jsonb) AS t(hex text, reg text, type text, cat text, src text, seen timestamptz)
                    ON CONFLICT (hex) DO UPDATE SET last_seen = GREATEST(aircraft.last_seen, EXCLUDED.last_seen),
                      registration = COALESCE(EXCLUDED.registration, aircraft.registration),
                      type_code = COALESCE(EXCLUDED.type_code, aircraft.type_code),
                      category = COALESCE(EXCLUDED.category, aircraft.category)""")
                    .param("rows", json.writeValueAsString(rows)).update();
            for (AircraftState s : chunk) {
                Written prev = written.get(s.hex());
                written.put(s.hex(), new Written(
                        s.registration() != null ? s.registration() : prev == null ? null : prev.registration(),
                        s.typeCode() != null ? s.typeCode() : prev == null ? null : prev.typeCode(),
                        s.category() != null ? s.category() : prev == null ? null : prev.category(), now));
            }
        }
        if (written.size() > CACHE_MAX) written.values().removeIf(w -> now - w.atMs() > 10 * LAST_SEEN_INTERVAL_MS);
        return due.size();
    }

    public Map<String, Object> find(String hex) {
        return Sql.publicRead(db, "aircraft.find", "SELECT hex, registration, type_code, category, source, first_seen, last_seen FROM aircraft WHERE hex = :hex")
                .param("hex", hex).query().listOfRows().stream().findFirst().map(m -> {
                    var out = new LinkedHashMap<String, Object>();
                    m.forEach((k, v) -> out.put(k, v));
                    out.put("first_seen", Sql.toInstant(m.get("first_seen")));
                    out.put("last_seen", Sql.toInstant(m.get("last_seen")));
                    return (Map<String, Object>) out;
                }).orElse(null);
    }

    /**
     * hex·등록부호 앞부분 일치(대문자, 호출자가 [A-Z0-9-] 로 검사한 값). 앞부분 일치를 바이트 순서 범위 [p, p 의 마지막 글자 + 1) 로 쓴다 —
     * text_pattern_ops 인덱스(V9 aircraft_hex_prefix · aircraft_registration_prefix)를 파라미터로도 쓸 수 있다(LIKE :p 는 일반 계획에서
     * 인덱스를 못 써 표 전체를 훑었다, R-51).
     */
    public List<Map<String, Object>> search(String prefix, int limit) {
        if (prefix == null || prefix.isEmpty()) return List.of();
        String hi = prefix.substring(0, prefix.length() - 1) + (char) (prefix.charAt(prefix.length() - 1) + 1);
        return Sql.publicRead(db, "aircraft.search", """
                SELECT hex, registration, type_code, last_seen FROM aircraft
                WHERE (upper(hex) ~>=~ :lo AND upper(hex) ~<~ :hi) OR (upper(registration) ~>=~ :lo AND upper(registration) ~<~ :hi)
                ORDER BY last_seen DESC LIMIT :n""")
                .param("lo", prefix).param("hi", hi).param("n", limit).query().listOfRows().stream().map(m -> {
                    var out = new LinkedHashMap<String, Object>(m);
                    out.put("last_seen", Sql.toInstant(m.get("last_seen")));
                    return (Map<String, Object>) out;
                }).toList();
    }
}
