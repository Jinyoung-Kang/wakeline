package dev.skywx.ops;

import dev.skywx.config.AppProperties;
import dev.skywx.config.ClientIp;
import dev.skywx.config.RequestIdFilter;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/** audit_log (INSERT 전용 권한): 누가·언제·무엇·이전값·이후값·IP·request_id. */
@Service
public class AuditService {
    private final JdbcClient db;
    private final ObjectMapper json;
    private final AppProperties props;

    public AuditService(JdbcClient db, ObjectMapper json, AppProperties props) {
        this.db = db;
        this.json = json;
        this.props = props;
    }

    public void record(HttpServletRequest req, Integer userId, String action, String target, Object before, Object after) {
        db.sql("""
                INSERT INTO audit_log (user_id, action, target, before, after, ip, request_id)
                VALUES (:uid, :action, :target, :before::jsonb, :after::jsonb, :ip::inet, :rid)""")
                .param("uid", userId).param("action", action).param("target", target)
                .param("before", before == null ? null : json.writeValueAsString(before))
                .param("after", after == null ? null : json.writeValueAsString(after))
                .param("ip", ClientIp.resolve(req, props.trustedProxy())).param("rid", RequestIdFilter.current(req)).update();
    }
}
