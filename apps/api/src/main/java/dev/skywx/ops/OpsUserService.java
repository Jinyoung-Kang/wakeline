package dev.skywx.ops;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

/** 운영자 계정: BCrypt, 5회 실패 시 15분 잠금. 계정은 CLI(make ops-user)로만 만든다. */
@Service
public class OpsUserService {
    public static final int MAX_FAILED = 5;
    public static final int LOCK_MINUTES = 15;
    private final JdbcClient db;
    private final PasswordEncoder encoder = new BCryptPasswordEncoder(12);

    public OpsUserService(JdbcClient db) { this.db = db; }

    /** 세션(Redis, JDK 직렬화)에 저장되므로 Serializable. */
    public record User(int id, String username, String role) implements java.io.Serializable {}

    public void upsert(String username, String password) {
        db.sql("""
                INSERT INTO ops_user (username, password_hash, role) VALUES (:u, :h, 'OPS')
                ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_count = 0, locked_until = NULL""")
                .param("u", username).param("h", encoder.encode(password)).update();
    }

    /** @return 성공 시 사용자. 실패·잠금은 empty (사유는 구분하지 않는다 — 존재 여부 비공개). */
    public Optional<User> authenticate(String username, String password) {
        Optional<Map<String, Object>> row = db.sql("SELECT id, username, password_hash, role, failed_count, locked_until FROM ops_user WHERE username = :u")
                .param("u", username).query().listOfRows().stream().findFirst();
        if (row.isEmpty()) {
            encoder.matches(password, "$2a$12$C6UzMDM.H6dfI/f/IKcEeO5fHhy2oXWKQzSEWMSo8pvj3mOwVbw3i"); // 타이밍 균일화
            return Optional.empty();
        }
        Map<String, Object> r = row.get();
        Object locked = r.get("locked_until");
        Instant lockedUntil = locked == null ? null : dev.skywx.persist.TrackRepository.toInstant(locked);
        int id = ((Number) r.get("id")).intValue();
        if (lockedUntil != null && lockedUntil.isAfter(Instant.now())) return Optional.empty();
        if (!encoder.matches(password, String.valueOf(r.get("password_hash")))) {
            int failed = ((Number) r.get("failed_count")).intValue() + 1;
            if (failed >= MAX_FAILED) {
                db.sql("UPDATE ops_user SET failed_count = 0, locked_until = now() + make_interval(mins => :m) WHERE id = :id").param("m", LOCK_MINUTES).param("id", id).update();
            } else {
                db.sql("UPDATE ops_user SET failed_count = :f WHERE id = :id").param("f", failed).param("id", id).update();
            }
            return Optional.empty();
        }
        db.sql("UPDATE ops_user SET failed_count = 0, locked_until = NULL WHERE id = :id").param("id", id).update();
        return Optional.of(new User(id, String.valueOf(r.get("username")), String.valueOf(r.get("role"))));
    }
}
