package dev.wakeline;

import javax.sql.DataSource;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Savepoint;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 저장소가 실제로 실행하는 문장(같은 SQL · 같은 파라미터 바인딩 형)의 실행 계획을 잡는 테스트 도구. SQL 에 marker 가 든 PreparedStatement 가
 * 실행되기 직전에 같은 연결에서 계획을 한 번 구해 모은다(JSON 문자열). 원래 문장은 그대로 한 번 실행된다.
 * <ul>
 *   <li>{@link Mode#CUSTOM}: {@code EXPLAIN (FORMAT JSON)} 를 같은 파라미터 값으로 — 처음 몇 번의 실행(맞춤 계획)과 같다.</li>
 *   <li>{@link Mode#ANALYZE}: {@code EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)} — 쓰기 문장은 세이브포인트(자동 커밋이면 임시 트랜잭션) 안에서
 *       실행하고 되돌린다.</li>
 *   <li>{@link Mode#GENERIC}: 같은 문장을 pgjdbc 가 보내는 파라미터 형({@code $n::varchar} 등)으로 PREPARE 하고
 *       {@code plan_cache_mode = force_generic_plan} 으로 {@code EXPLAIN EXECUTE} — 같은 문장을 여러 번 실행한 연결이 결국 쓰는 일반 계획
 *       (plan cache)과 같다. 값에 따라 달라지는 최적화가 없다.</li>
 * </ul>
 */
public final class PlanCapture {
    public enum Mode { CUSTOM, ANALYZE, GENERIC }

    private final DataSource target;
    private final String marker;
    private final Mode mode;
    public final List<String> plans = java.util.Collections.synchronizedList(new ArrayList<>());

    public PlanCapture(DataSource target, String marker, Mode mode) {
        this.target = target;
        this.marker = marker;
        this.mode = mode;
    }

    public DataSource dataSource() {
        return (DataSource) Proxy.newProxyInstance(DataSource.class.getClassLoader(), new Class<?>[]{DataSource.class}, (p, m, a) -> {
            Object r = invoke(target, m, a);
            return r instanceof Connection c ? connection(c) : r;
        });
    }

    private Connection connection(Connection real) {
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, (p, m, a) -> {
            Object r = invoke(real, m, a);
            if (m.getName().equals("prepareStatement") && a != null && a.length > 0 && a[0] instanceof String sql && sql.contains(marker)
                    && r instanceof PreparedStatement ps) return statement(real, ps, sql);
            return r;
        });
    }

    private record Call(Method method, Object[] args) {}

    private PreparedStatement statement(Connection conn, PreparedStatement real, String sql) {
        List<Call> params = new ArrayList<>();
        InvocationHandler h = (p, m, a) -> {
            String n = m.getName();
            if (n.startsWith("set") && a != null && a.length >= 2 && a[0] instanceof Integer) params.add(new Call(m, a.clone()));
            if (n.equals("clearParameters")) params.clear();
            if (n.equals("executeQuery") || n.equals("executeUpdate") || n.equals("execute") || n.equals("executeLargeUpdate")) {
                if (mode == Mode.GENERIC) explainGeneric(conn, sql, params);
                else explain(conn, sql, params);
            }
            return invoke(real, m, a);
        };
        return (PreparedStatement) Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(), new Class<?>[]{PreparedStatement.class}, h);
    }

    private void explain(Connection conn, String sql, List<Call> params) throws Exception {
        String head = sql.stripLeading().toUpperCase(Locale.ROOT);
        boolean undo = mode == Mode.ANALYZE && !head.startsWith("SELECT") && !head.startsWith("WITH");
        boolean auto = conn.getAutoCommit();
        Savepoint sp = null;
        if (undo) {
            if (auto) conn.setAutoCommit(false);
            else sp = conn.setSavepoint();
        }
        try (PreparedStatement ex = conn.prepareStatement("EXPLAIN (FORMAT JSON" + (mode == Mode.ANALYZE ? ", ANALYZE, BUFFERS" : "") + ") " + sql)) {
            for (Call c : params) c.method().invoke(ex, c.args());
            try (ResultSet rs = ex.executeQuery()) {
                StringBuilder sb = new StringBuilder();
                while (rs.next()) sb.append(rs.getString(1));
                plans.add(sb.toString());
            }
        } finally {
            if (undo) {
                if (auto) {
                    conn.rollback();
                    conn.setAutoCommit(true);
                } else {
                    conn.rollback(sp);
                }
            }
        }
    }

    /** pgjdbc 가 setX 로 보내는 파라미터 형(OID). 없으면 형을 붙이지 않는다(서버가 문맥으로 정한다 — pgjdbc 의 unspecified 와 같다). */
    private static final Map<String, String> TYPES = Map.of("setString", "varchar", "setLong", "int8", "setInt", "int4", "setDouble", "float8",
            "setBoolean", "bool", "setShort", "int2", "setFloat", "float4", "setBigDecimal", "numeric");

    private void explainGeneric(Connection conn, String sql, List<Call> params) throws Exception {
        String[] types = new String[params.stream().mapToInt(c -> (Integer) c.args()[0]).max().orElse(0) + 1];
        for (Call c : params) {
            String t = TYPES.get(c.method().getName());
            if (c.method().getName().equals("setObject") && c.args()[1] instanceof String) t = "varchar";
            if (c.method().getName().equals("setObject") && c.args()[1] instanceof Long) t = "int8";
            if (c.method().getName().equals("setObject") && c.args()[1] instanceof Integer) t = "int4";
            types[(Integer) c.args()[0]] = t;
        }
        StringBuilder q = new StringBuilder();
        int n = 0;
        for (char ch : sql.toCharArray()) {
            if (ch == '?') {
                n++;
                String t = n < types.length ? types[n] : null;
                q.append('$').append(n);
                if (t != null) q.append("::").append(t);
            } else {
                q.append(ch);
            }
        }
        // 서버의 plan cache 와 같은 경로: 이름 있는 준비 문장 + plan_cache_mode = force_generic_plan → EXPLAIN EXECUTE(값은 계획에 쓰이지 않는다)
        String args = String.join(", ", java.util.Collections.nCopies(n, "NULL"));
        try (Statement st = conn.createStatement()) {
            st.execute("PREPARE wakeline_plan_capture AS " + q);
            try {
                st.execute("SET plan_cache_mode = force_generic_plan");
                try (ResultSet rs = st.executeQuery("EXPLAIN (FORMAT JSON) EXECUTE wakeline_plan_capture" + (n > 0 ? "(" + args + ")" : ""))) {
                    StringBuilder sb = new StringBuilder();
                    while (rs.next()) sb.append(rs.getString(1));
                    plans.add(sb.toString());
                }
            } finally {
                st.execute("RESET plan_cache_mode");
                st.execute("DEALLOCATE wakeline_plan_capture");
            }
        }
    }

    private static Object invoke(Object target, Method m, Object[] a) throws Throwable {
        try {
            return m.invoke(target, a);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
    }

    /** 모은 계획 중 마지막 것. */
    public String last() {
        if (plans.isEmpty()) throw new AssertionError("no statement containing '" + marker + "' was executed");
        return plans.getLast();
    }
}
