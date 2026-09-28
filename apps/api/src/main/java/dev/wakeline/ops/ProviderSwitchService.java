package dev.wakeline.ops;

import dev.wakeline.config.Problem;
import dev.wakeline.rest.StatusService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 공급자 스위치(R-94, 계약 v5 §D1 · ADR-019). 원본은 DB provider_switch(V11), collector 가 읽는 Redis 해시 wakeline:provider:{name} 의
 * disabled 는 미러다. 값의 뜻은 collector 와 같다: "1" 이면 꺼짐, 그 밖(필드 없음 포함)은 켜짐(collector status.py is_disabled).
 * <ul>
 *   <li>토글({@link #set}): 감사 행 + DB 갱신이 한 트랜잭션. 커밋 뒤 Redis 미러 — 실패하면 mirrored=false(변경은 확정, 주기 미러가 맞춘다).</li>
 *   <li>주기({@link #sync}, StartupMirror — 기동 시 + 60 s): 행이 없는 공급자는 그때의 Redis 값을 한 번 옮겨 담고(이관), DB → Redis 를 다시 미러한다.
 *       collector 는 같은 해시에 상태 필드를 쓰므로(ACL ~wakeline:provider:*) disabled 도 바꿀 수 있다 — 바꿔도 다음 주기에 DB 값으로 돌아온다.
 *       Redis 를 잃어도(볼륨 손실·AOF 복구) 꺼 둔 스위치가 조용히 '켜짐'으로 돌아가지 않는다.</li>
 *   <li>이관은 모든 공급자({@link StatusService#PROVIDERS})에 행을 만들므로 한 번뿐이다 — 이관 뒤 collector 가 쓴 값은 원본이 되지 않는다.
 *       Redis 를 읽지 못하면 행을 만들지 않는다(값을 모르는 채로 '켜짐'을 지어내지 않는다).</li>
 * </ul>
 * 미러는 값이 다를 때만 쓴다. 켜진 스위치는 해시에 필드가 없으면 쓰지 않는다(없음 = 켜짐) — 호출한 적 없는 공급자의 해시를 만들지 않아
 * 운영 목록(/ops/providers, 해시가 있는 공급자만)이 달라지지 않는다.
 */
@Service
public class ProviderSwitchService {
    private static final Logger log = LoggerFactory.getLogger(ProviderSwitchService.class);
    static final String FIELD = "disabled";
    /** 이관 감사 행에 싣는 Redis 원문의 길이 상한 — collector 도 쓸 수 있는 값이라 그대로 믿지 않는다. */
    static final int MAX_RAW = 32;

    /** 변경 감사 기록 콜백(같은 트랜잭션 안에서 불린다). before 는 행이 없으면 disabled·version 이 null. */
    @FunctionalInterface
    public interface AuditHook { void record(Object before, Object after); }

    /** @param imported 이번에 Redis 값을 옮겨 담은 공급자 @param corrected Redis 값이 DB 와 달라 고쳐 쓴 공급자 */
    public record SyncResult(List<String> imported, List<String> corrected) {}

    private final JdbcClient db;
    private final StringRedisTemplate redis;
    private final TransactionTemplate tx;
    private final AuditService audit;

    public ProviderSwitchService(JdbcClient db, StringRedisTemplate redis, TransactionTemplate tx, AuditService audit) {
        this.db = db;
        this.redis = redis;
        this.tx = tx;
        this.audit = audit;
    }

    public static String key(String provider) { return "wakeline:provider:" + provider; }

    /**
     * 스위치 변경 + 감사(한 트랜잭션) → 커밋 뒤 Redis 미러. 같은 값으로 다시 눌러도 version 이 오르고 감사 행이 남는다(운영자의 결정 기록).
     * @return {provider, disabled, version, updated_at, mirrored}
     */
    public Map<String, Object> set(String provider, boolean disabled, Integer userId, AuditHook auditHook) {
        if (!StatusService.PROVIDERS.contains(provider)) throw Problem.notFound("provider not found");
        Map<String, Object> row = tx.execute(status -> {
            Map<String, Object> before = find(provider, true);
            // 행이 없으면(이관 전) 만든다 — 동시에 두 토글이 와도 한 행(PK 충돌은 갱신으로)
            db.sql("""
                    INSERT INTO provider_switch (provider, disabled, version, updated_at, updated_by) VALUES (:p, :d, 1, now(), :uid)
                    ON CONFLICT (provider) DO UPDATE SET disabled = EXCLUDED.disabled, version = provider_switch.version + 1,
                        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by""")
                    .param("p", provider).param("d", disabled).param("uid", userId).update();
            Map<String, Object> after = find(provider, false);
            auditHook.record(state(before), state(after));
            return after;
        });
        Map<String, Object> out = new LinkedHashMap<>(row);
        out.put("mirrored", tryMirror());
        return out;
    }

    private boolean tryMirror() {
        try {
            mirror();
            return true;
        } catch (RuntimeException e) {
            log.warn("provider switch mirror to redis failed (periodic mirror will retry): {}", e.toString());
            return false;
        }
    }

    /**
     * 이관(행이 없는 공급자) → DB → Redis 미러. 기동 시·60 s 마다(StartupMirror). Redis·DB 장애면 예외 — 다음 주기에 다시 한다.
     * 읽기와 쓰기를 한 락 안에서 해서, 오래된 값을 읽은 주기 미러가 토글 직후의 미러를 덮어쓰지 못하게 한다(SettingsService.mirror 와 같다).
     */
    public synchronized SyncResult sync() {
        List<String> imported = importMissing();
        return new SyncResult(imported, mirrorRows());
    }

    /** DB → Redis 미러(토글 커밋 뒤). @return Redis 값이 달라 고쳐 쓴 공급자 */
    public synchronized List<String> mirror() { return mirrorRows(); }

    private List<String> mirrorRows() {
        List<String> corrected = new ArrayList<>();
        for (var r : db.sql("SELECT provider, disabled FROM provider_switch ORDER BY provider").query().listOfRows()) {
            String p = String.valueOf(r.get("provider"));
            if (!StatusService.PROVIDERS.contains(p)) continue; // 운영 API 로는 생기지 않는 행 — 모르는 해시를 만들지 않는다
            String want = Boolean.TRUE.equals(r.get("disabled")) ? "1" : "0";
            Object cur = redis.opsForHash().get(key(p), FIELD);
            if (want.equals(cur) || (cur == null && "0".equals(want))) continue; // 같거나, 필드 없음 = 켜짐
            redis.opsForHash().put(key(p), FIELD, want);
            corrected.add(p);
        }
        return corrected;
    }

    /** 행이 없는 공급자마다 지금 Redis 값을 한 행으로 옮겨 담는다(시스템 감사 행과 한 트랜잭션). 이미 행이 있으면(토글이 먼저 만든 경우 포함) 건드리지 않는다. */
    private List<String> importMissing() {
        Set<String> have = new HashSet<>(db.sql("SELECT provider FROM provider_switch").query(String.class).list());
        List<String> imported = new ArrayList<>();
        for (String p : StatusService.PROVIDERS) {
            if (have.contains(p)) continue;
            Object raw = redis.opsForHash().get(key(p), FIELD); // Redis 장애면 여기서 예외 — 값을 모르는 채로 행을 만들지 않는다
            boolean disabled = "1".equals(raw);
            Boolean inserted = tx.execute(status -> {
                int n = db.sql("""
                        INSERT INTO provider_switch (provider, disabled, version, updated_at, updated_by) VALUES (:p, :d, 1, now(), NULL)
                        ON CONFLICT (provider) DO NOTHING""").param("p", p).param("d", disabled).update();
                if (n == 1) {
                    Map<String, Object> before = new LinkedHashMap<>();
                    before.put("redis_disabled", raw == null ? null : truncate(String.valueOf(raw)));
                    audit.recordSystem("PROVIDER_SWITCH_IMPORT", p, before, state(find(p, false)));
                }
                return n == 1;
            });
            if (Boolean.TRUE.equals(inserted)) imported.add(p);
        }
        return imported;
    }

    private static String truncate(String s) { return s.length() > MAX_RAW ? s.substring(0, MAX_RAW) : s; }

    private Map<String, Object> find(String provider, boolean forUpdate) {
        return db.sql("SELECT provider, disabled, version, updated_at FROM provider_switch WHERE provider = :p" + (forUpdate ? " FOR UPDATE" : ""))
                .param("p", provider).query(ProviderSwitchService::row).optional().orElse(null);
    }

    private static Map<String, Object> row(ResultSet rs, int n) throws SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("provider", rs.getString("provider"));
        m.put("disabled", rs.getBoolean("disabled"));
        m.put("version", rs.getInt("version"));
        m.put("updated_at", rs.getObject("updated_at", OffsetDateTime.class).toInstant());
        return m;
    }

    /** 감사 행의 before/after: {disabled, version} — 행이 없으면 둘 다 null(모름). */
    private static Map<String, Object> state(Map<String, Object> row) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("disabled", row == null ? null : row.get("disabled"));
        m.put("version", row == null ? null : row.get("version"));
        return m;
    }
}
