package dev.skywx.ops;

import dev.skywx.config.AppProperties;
import dev.skywx.config.ClientIp;
import dev.skywx.config.RequestIdFilter;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/**
 * audit_log (INSERT 전용 권한): 누가·언제·무엇·이전값·이후값·IP·request_id.
 * 호출자가 트랜잭션 안에서 부르면 같은 트랜잭션에 들어간다(JdbcClient) — 변경과 감사 기록이 함께 커밋·취소된다(SEC-11).
 */
@Service
public class AuditService {
    /** target 은 사용자 입력(로그인 사용자명 등)일 수 있다 — 길이를 잘라 저장한다. */
    static final int MAX_TARGET = 128;
    private final JdbcClient db;
    private final ObjectMapper json;
    private final AppProperties props;

    public AuditService(JdbcClient db, ObjectMapper json, AppProperties props) {
        this.db = db;
        this.json = json;
        this.props = props;
    }

    public void record(HttpServletRequest req, Integer userId, String action, String target, Object before, Object after) {
        insert(userId, action, target, before, after, ClientIp.resolve(req, props.trustedProxy()), RequestIdFilter.current(req));
    }

    /** 요청이 없는 시스템 변경(기동 시 .env 값 반영 등). user_id·ip·request_id 는 NULL. */
    public void recordSystem(String action, String target, Object before, Object after) {
        insert(null, action, target, before, after, null, null);
    }

    private void insert(Integer userId, String action, String target, Object before, Object after, String ip, String requestId) {
        db.sql("""
                INSERT INTO audit_log (user_id, action, target, before, after, ip, request_id)
                VALUES (:uid, :action, :target, :before::jsonb, :after::jsonb, :ip::inet, :rid)""")
                .param("uid", userId).param("action", action)
                .param("target", target == null ? null : target.length() > MAX_TARGET ? target.substring(0, MAX_TARGET) : target)
                .param("before", before == null ? null : json.writeValueAsString(before))
                .param("after", after == null ? null : json.writeValueAsString(after))
                .param("ip", ip).param("rid", requestId).update();
    }
}
