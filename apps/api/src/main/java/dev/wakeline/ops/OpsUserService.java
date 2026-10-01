package dev.wakeline.ops;

import dev.wakeline.platform.data.Sql;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

/**
 * 운영자 계정: BCrypt(12), 5회 실패 시 15분 잠금. 계정은 CLI(make ops-user)로만 만든다. 비밀번호를 바꾸면 기존 세션을 지운다(R-95).
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
    private final OpsSessionRegistry sessions;
    private final PasswordEncoder encoder = new BCryptPasswordEncoder(12);

    public OpsUserService(JdbcClient db, OpsSessionRegistry sessions) {
        this.db = db;
        this.sessions = sessions;
    }

    /** 비밀번호는 바뀌었지만 기존 세션을 지우지 못했다(Redis 장애) — CLI 가 알리고 실패 코드로 끝낸다. 다시 실행하면 다시 지운다. */
    public static final class SessionsNotRevoked extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public SessionsNotRevoked(String username, Throwable cause) {
            super("password for '" + username + "' was updated, but existing sessions could not be revoked: " + cause, cause);
        }
    }

    /** 세션(Redis, JDK 직렬화)에 저장되므로 Serializable. */
    public record User(int id, String username, String role) implements java.io.Serializable {}

    /** 실패 사유는 감사 기록에만 쓴다(응답은 구분하지 않는다 — 계정 존재·잠금 여부 비공개). */
    public enum Failure { UNKNOWN_USER, BAD_PASSWORD, LOCKED }

    /**
     * @param user     성공 시 사용자
     * @param failure  실패 사유(성공이면 null)
     * @param lockedNow 이번 실패로 계정이 잠겼다(ACCOUNT_LOCKED 감사 기록용)
     */
    public record AuthResult(Optional<User> user, Failure failure, boolean lockedNow, String credential) {
        static AuthResult ok(User u, String credential) { return new AuthResult(Optional.of(u), null, false, credential); }
        static AuthResult fail(Failure f, boolean lockedNow) { return new AuthResult(Optional.empty(), f, lockedNow, null); }
    }

    /**
     * 자격 표식(R-95 후속): 로그인 때 확인한 비밀번호 해시의 지문. BCrypt 해시는 교체마다 새 솔트로 바뀌므로 비밀번호 버전으로 쓸 수 있다.
     * 세션에 이 값을 두고 운영 요청마다 지금 값과 비교한다({@code OpsSessionLifetimeFilter}) — 로그인과 교체가 겹쳐 세션 목록 삭제(revokeAll)를
     * 피한 세션도 다음 요청에서 끝난다. 해시 자체는 세션에 두지 않는다(SHA-256 앞 16바이트, 16진).
     */
    public static String credentialTag(String passwordHash) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(passwordHash.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(d, 0, 16);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** 지금 자격 표식. 사용자가 없으면 empty. DB 오류는 그대로 올린다(호출자가 실패 시 닫힘으로 처리). */
    public Optional<String> currentCredentialTag(int userId) {
        return db.sql("SELECT password_hash FROM ops_user WHERE id = :id").param("id", userId).query(String.class).optional().map(OpsUserService::credentialTag);
    }

    /**
     * 계정 생성 또는 비밀번호 교체(make ops-user). 교체면 그 사용자의 기존 운영 세션을 모두 지운다(R-95 — 탈취된 세션이 비밀번호 교체 뒤에도
     * 살아 있으면 안 된다). 비밀번호 변경은 세션 폐기가 실패해도 되돌리지 않는다(예전 비밀번호로 돌아가는 편이 더 위험) — {@link SessionsNotRevoked}.
     * @return 지운 기존 세션 수
     */
    public int upsert(String username, String password) {
        int id = db.sql("""
                INSERT INTO ops_user (username, password_hash, role) VALUES (:u, :h, 'OPS')
                ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_count = 0, locked_until = NULL
                RETURNING id""")
                .param("u", username).param("h", encoder.encode(password)).query(Integer.class).single();
        try {
            return sessions.revokeAll(id);
        } catch (RuntimeException e) {
            throw new SessionsNotRevoked(username, e);
        }
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
        Instant lockedUntil = r.get("locked_until") == null ? null : Sql.toInstant(r.get("locked_until"));
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
        // 표식은 방금 비교한 그 해시로 만든다(같은 행) — 비교 뒤 바뀐 비밀번호로 만든 표식이면 경합을 놓친다
        return AuthResult.ok(new User(id, String.valueOf(r.get("username")), String.valueOf(r.get("role"))), credentialTag(String.valueOf(r.get("password_hash"))));
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
