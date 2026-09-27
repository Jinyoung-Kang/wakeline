package dev.skywx.ops;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

/**
 * 운영자 계정: BCrypt(12), 5회 실패 시 15분 잠금. 계정은 CLI(make ops-user)로만 만든다.
 * 실패 집계는 한 문장의 원자적 UPDATE(failed_count = failed_count + 1 … RETURNING) — 동시 실패가 서로를 덮어쓰지 않는다(COR-21·SEC-6).
 * 잠긴 계정·없는 계정도 BCrypt 비교를 한 번 한다 — 응답 시간으로 잠금 여부·계정 존재를 알 수 없게.
 */
@Service
public class OpsUserService {
    public static final int MAX_FAILED = 5;
    public static final int LOCK_MINUTES = 15;
    /** 타이밍 균일화용 더미 해시(BCrypt 12). 어떤 비밀번호와도 일치하지 않는다. */
    private static final String DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEeO5fHhy2oXWKQzSEWMSo8pvj3mOwVbw3i";
    private final JdbcClient db;
    private final PasswordEncoder encoder = new BCryptPasswordEncoder(12);

    public OpsUserService(JdbcClient db) { this.db = db; }

    /** 세션(Redis, JDK 직렬화)에 저장되므로 Serializable. */
    public record User(int id, String username, String role) implements java.io.Serializable {}

    /** 실패 사유는 감사 기록에만 쓴다(응답은 구분하지 않는다 — 계정 존재·잠금 여부 비공개). */
    public enum Failure { UNKNOWN_USER, BAD_PASSWORD, LOCKED }

    /**
     * @param user     성공 시 사용자
     * @param failure  실패 사유(성공이면 null)
     * @param lockedNow 이번 실패로 계정이 잠겼다(ACCOUNT_LOCKED 감사 기록용)
     */
    public record AuthResult(Optional<User> user, Failure failure, boolean lockedNow) {
        static AuthResult ok(User u) { return new AuthResult(Optional.of(u), null, false); }
        static AuthResult fail(Failure f, boolean lockedNow) { return new AuthResult(Optional.empty(), f, lockedNow); }
    }

    public void upsert(String username, String password) {
        db.sql("""
                INSERT INTO ops_user (username, password_hash, role) VALUES (:u, :h, 'OPS')
                ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_count = 0, locked_until = NULL""")
                .param("u", username).param("h", encoder.encode(password)).update();
    }

    public AuthResult authenticate(String username, String password) {
        Optional<Map<String, Object>> row = db.sql("SELECT id, username, password_hash, role, locked_until FROM ops_user WHERE username = :u")
                .param("u", username).query().listOfRows().stream().findFirst();
        if (row.isEmpty()) {
            encoder.matches(password, DUMMY_HASH); // 타이밍 균일화
            return AuthResult.fail(Failure.UNKNOWN_USER, false);
        }
        Map<String, Object> r = row.get();
        int id = ((Number) r.get("id")).intValue();
        Instant lockedUntil = r.get("locked_until") == null ? null : dev.skywx.persist.TrackRepository.toInstant(r.get("locked_until"));
        if (lockedUntil != null && lockedUntil.isAfter(Instant.now())) {
            encoder.matches(password, DUMMY_HASH); // 잠긴 계정도 같은 시간이 걸린다(잠금 해제 시각을 재지 못하게)
            return AuthResult.fail(Failure.LOCKED, false);
        }
        if (!encoder.matches(password, String.valueOf(r.get("password_hash")))) {
            return AuthResult.fail(Failure.BAD_PASSWORD, recordFailure(id));
        }
        // 성공: 그 사이(BCrypt 비교 중) 다른 요청이 잠갔다면 성공으로 치지 않는다
        int n = db.sql("UPDATE ops_user SET failed_count = 0, locked_until = NULL WHERE id = :id AND (locked_until IS NULL OR locked_until <= now())")
                .param("id", id).update();
        if (n == 0) return AuthResult.fail(Failure.LOCKED, false);
        return AuthResult.ok(new User(id, String.valueOf(r.get("username")), String.valueOf(r.get("role"))));
    }

    /**
     * 실패 1회를 원자적으로 센다. MAX_FAILED 번째 실패면 잠그고 카운터를 0 으로 되돌린다.
     * 이미 (다른 요청에 의해) 잠겨 있으면 세지 않는다.
     * @return 이번 실패로 잠겼는가
     */
    boolean recordFailure(int id) {
        return db.sql("""
                UPDATE ops_user SET
                  failed_count = CASE WHEN failed_count + 1 >= :max THEN 0 ELSE failed_count + 1 END,
                  locked_until = CASE WHEN failed_count + 1 >= :max THEN now() + make_interval(mins => :m) ELSE locked_until END
                WHERE id = :id AND (locked_until IS NULL OR locked_until <= now())
                RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked_now""")
                .param("max", MAX_FAILED).param("m", LOCK_MINUTES).param("id", id)
                .query(Boolean.class).optional().orElse(false);
    }
}
