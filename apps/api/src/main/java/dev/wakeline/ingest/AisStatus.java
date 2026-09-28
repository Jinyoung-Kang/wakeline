package dev.wakeline.ingest;

import dev.wakeline.domain.AisBboxes;
import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.AisScope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * ais 수집기의 상태 해시(wakeline:ais:status, 계약 v2 §B1)를 읽어 검증한 값 — 화면의 AIS 배지(status.sources.ais)와 선박 만료의 '수신 끊김'
 * 판단에 쓴다. 해시는 수집기가 5 s 마다(상태가 바뀌면 바로) 쓰고 api 는 {@link ShipSweeper} 가 5 s 마다 한 번 읽는다(요청·세션마다 읽지 않는다).
 * <ul>
 *   <li>값은 믿지 않고 형식을 검사한다: 시각은 시간대가 있는 ISO 만, 숫자는 유한·0 이상, 문자열은 200자까지. 틀린 값은 null(모름).</li>
 *   <li>수집기의 연결 상태(connected)는 heartbeat(updated_at)가 30 s 안일 때만 '지금' 값으로 쓴다 — 수집기가 죽었으면 마지막 값이 '연결됨'
 *       이어도 지금 연결돼 있다고 말하지 않는다(null = 모름). 읽기 실패(Redis 장애)는 이전 값을 두어 heartbeat 가 저절로 오래되게 한다.</li>
 *   <li>구역(계약 v4 §D): 해시의 shards = 구역별 상태 JSON 배열(≤ 3). 구역의 scope 는 운영 설정과 같은 규칙으로 검사하고, 배열 모양이 틀리거나
 *       scope 하나라도 틀리면 구역 정보 전체를 모름(null)으로 두고 합계 필드만 쓴다(일부 구역만 보여 범위를 잘못 말하지 않는다).</li>
 * </ul>
 */
@Component
public class AisStatus {
    private static final Logger log = LoggerFactory.getLogger(AisStatus.class);
    public static final String KEY = "wakeline:ais:status";
    /** 수집기는 5 s 마다 쓴다 — 이보다 오래되면 수집기 상태를 '지금' 값으로 보지 않는다. */
    static final long HEARTBEAT_MAX_AGE_MS = 30_000;
    /** api 가 ships 메시지를 이만큼 받지 못했으면(소비 멈춤·Redis 장애) 수신이 끊긴 것으로 본다. */
    static final long STALL_MS = 120_000;
    static final int TEXT_MAX = 200;
    /** 수집기 상태 이름(ais/feed.py Feed.state, 계약 v3 §A) — 이 밖의 값은 모름(null). */
    static final Set<String> STATES = Set.of("starting", "connecting", "subscribed", "receiving", "backoff", "replaying", "disabled", "stopped");
    /** shards JSON 의 길이 상한 — 구역 3개 × (scope 1,024자 + 다른 필드) 를 넉넉히 덮는다. 넘으면 모름. */
    static final int SHARDS_TEXT_MAX = 8_192;
    private static final JsonMapper JSON = JsonMapper.builder().build();

    /**
     * 구역 하나의 상태(계약 v4 §D shards[] 중 api 가 쓰는 필드만). scope = 검사한 구역, state = 알려진 상태 이름만, connected = 참·거짓(모르면 null),
     * gapOpenSince = 이 구역의 열린 공백 시작(없으면 null), gapReason = 그 원인(200자까지).
     */
    public record Shard(AisScope scope, String state, Boolean connected, Instant gapOpenSince, String gapReason) {
        /** 수신이 끊겼거나 모르는가 — 열린 공백 · 끊김 보고 · 연결 상태 모름(멈추는 쪽으로). */
        boolean down() { return gapOpenSince != null || !Boolean.TRUE.equals(connected); }
    }

    /**
     * 검증한 상태 해시. present = 해시가 있었다. connected 는 수집기 보고값 그대로(지금 값인지는 {@link #connectedNow}).
     * state = 알려진 상태 이름만(아니면 null). coverage = 수집기가 지금 구독한 상자 [[lat1, lon1, lat2, lon2], ...] — 구역 정보가 있으면 모든 구역 상자의 합,
     * 없으면 해시의 bbox(형식 오류·빈 값이면 null). shards = 구역별 상태(1~3개, 없거나 틀리면 null).
     */
    public record Feed(boolean present, String provider, Boolean connected, Instant updatedAt, Instant lastMsgAt, Double msgsPerS,
                       Instant gapOpenSince, String gapReason, AisGap lastGap, String state, List<List<Double>> coverage, List<Shard> shards) {
        static final Feed ABSENT = new Feed(false, null, null, null, null, null, null, null, null, null, null, null);

        /** heartbeat 가 최근인가(미래로 1분 넘게 틀어진 시각도 믿지 않는다). */
        public boolean heartbeatFresh(long nowMs) {
            if (updatedAt == null) return false;
            long t = updatedAt.toEpochMilli();
            return nowMs - t <= HEARTBEAT_MAX_AGE_MS && t - nowMs <= 60_000;
        }

        /** 지금의 연결 상태 — heartbeat 가 오래됐으면 null(모름). */
        public Boolean connectedNow(long nowMs) { return heartbeatFresh(nowMs) ? connected : null; }

        /**
         * 지금 열린 공백들: 구역 정보가 있으면 열린 구역마다 하나(scope 포함), 없으면 합계 gap_open_since 하나(구역 없음 — 모든 곳에 적용).
         * 합계는 열려 있다는데 열린 구역이 하나도 없으면(어긋남) 합계 공백을 구역 없이 둔다(선을 덜 끊는 쪽으로 추정하지 않는다).
         */
        public List<AisGap> openGaps() {
            List<AisGap> out = new ArrayList<>();
            if (shards != null) {
                for (Shard sh : shards) if (sh.gapOpenSince() != null) out.add(new AisGap(sh.gapOpenSince(), null, sh.gapReason(), provider, sh.scope()));
            }
            if (out.isEmpty() && gapOpenSince != null) out.add(new AisGap(gapOpenSince, null, gapReason, provider));
            return out;
        }
    }

    private final StringRedisTemplate redis;
    private final ShipStore ships;
    private volatile Feed feed = Feed.ABSENT;

    public AisStatus(StringRedisTemplate redis, ShipStore ships) {
        this.redis = redis;
        this.ships = ships;
    }

    public Feed current() { return feed; }

    /** 해시를 한 번 읽는다(스케줄러 스레드). 실패하면 이전 값을 둔다. */
    public void refresh() {
        try {
            update(redis.opsForHash().entries(KEY));
        } catch (RuntimeException e) {
            log.debug("ais status unavailable: {}", e.toString());
        }
    }

    /** 읽은 해시로 바꾼다(빈 해시 = 수집기 상태 없음). */
    void update(Map<Object, Object> hash) { feed = parse(hash); }

    static Feed parse(Map<Object, Object> h) {
        if (h == null || h.isEmpty()) return Feed.ABSENT;
        Instant ls = time(h, "last_gap_started_at"), le = time(h, "last_gap_ended_at");
        String provider = text(h, "provider");
        AisGap last = ls != null && le != null && le.isAfter(ls) ? new AisGap(ls, le, text(h, "last_gap_reason"), provider) : null;
        String c = text(h, "connected");
        Boolean connected = "1".equals(c) ? Boolean.TRUE : "0".equals(c) ? Boolean.FALSE : null;
        List<Shard> shards = shards(h.get("shards"));
        List<List<Double>> coverage = shards != null ? union(shards) : coverage(h.get("bbox"));
        return new Feed(true, provider, connected, time(h, "updated_at"), time(h, "last_msg_at"), number(h, "msgs_per_s"),
                time(h, "gap_open_since"), text(h, "gap_reason"), last, known(text(h, "state")), coverage, shards);
    }

    private static String known(String state) { return state != null && STATES.contains(state) ? state : null; }

    /**
     * 상태 해시의 bbox(수집기가 지금 구독한 영역, ais/bbox.py 의 정규화 문자열 — 구역을 '|' 로 나눴을 수 있다) → [[lat1, lon1, lat2, lon2], ...]
     * (모든 구역 상자의 합). 운영 설정과 같은 규칙({@link AisBboxes#parseShards})을 통과한 값만 — 비었거나(구독 전·비활성) 형식이 틀리면 null
     * (범위를 추정해 그리지 않는다).
     */
    static List<List<Double>> coverage(Object raw) {
        if (raw == null) return null;
        String s = String.valueOf(raw).strip();
        if (s.isEmpty()) return null;
        try {
            List<List<Double>> out = new ArrayList<>();
            for (List<double[]> shard : AisBboxes.parseShards(s)) for (double[] b : shard) out.add(List.of(b[0], b[1], b[2], b[3]));
            return List.copyOf(out);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** 구역들의 상자 합(구역 순서 · 구역 안 순서 그대로). */
    static List<List<Double>> union(List<Shard> shards) {
        List<List<Double>> out = new ArrayList<>();
        for (Shard sh : shards) out.addAll(sh.scope().coverage());
        return List.copyOf(out);
    }

    /**
     * 상태 해시의 shards(계약 v4 §D: JSON 배열 ≤ 3, 원소 {scope, state, connected, last_msg_at, msgs_per_s, lag_p50_s, gap_open_since, gap_reason,
     * sessions_ended}) → 검증한 구역 목록. api 가 쓰는 필드만 읽는다. 없거나 빈 배열이면 null(구역 정보 없음 — 합계 필드만 쓴다).
     * 배열이 아니거나 3개를 넘거나, 원소가 객체가 아니거나 scope 가 구역 규칙({@link AisScope#parse})에 맞지 않으면 전체를 null(모름).
     * 원소의 다른 필드는 하나씩 검사해 틀리면 그 값만 null.
     */
    static List<Shard> shards(Object raw) {
        if (raw == null) return null;
        String s = String.valueOf(raw).strip();
        if (s.isEmpty() || s.length() > SHARDS_TEXT_MAX) return null;
        JsonNode arr;
        try {
            arr = JSON.readTree(s);
        } catch (RuntimeException e) {
            return null;
        }
        if (arr == null || !arr.isArray() || arr.isEmpty() || arr.size() > AisBboxes.MAX_SHARDS) return null;
        List<Shard> out = new ArrayList<>(arr.size());
        for (JsonNode n : arr) {
            JsonNode sc = n.isObject() ? n.get("scope") : null;
            if (sc == null || !sc.isString()) return null;
            AisScope scope;
            try {
                scope = AisScope.parse(sc.asString());
            } catch (IllegalArgumentException e) {
                return null;
            }
            out.add(new Shard(scope, known(jsonText(n, "state")), bool(n.get("connected")), jsonTime(n, "gap_open_since"), jsonText(n, "gap_reason")));
        }
        return List.copyOf(out);
    }

    private static String jsonText(JsonNode n, String k) {
        JsonNode v = n.get(k);
        if (v == null || !v.isString()) return null;
        String s = v.asString().strip();
        if (s.isEmpty()) return null;
        return s.length() > TEXT_MAX ? s.substring(0, TEXT_MAX) : s;
    }

    private static Instant jsonTime(JsonNode n, String k) {
        String s = jsonText(n, k);
        return s == null ? null : parseTime(s);
    }

    /** JSON 참·거짓(해시 필드처럼 "1"/"0"·1/0 도) — 그 밖은 모름(null). */
    private static Boolean bool(JsonNode v) {
        if (v == null) return null;
        if (v.isBoolean()) return v.asBoolean();
        if (v.isString() || v.isIntegralNumber()) {
            String t = v.asString().strip();
            return "1".equals(t) ? Boolean.TRUE : "0".equals(t) ? Boolean.FALSE : null;
        }
        return null;
    }

    /**
     * 수신이 끊겼거나 확인할 수 없는 곳이 있는가(전체 또는 일부 구역) — {@link #freeze} 가 멈추는 곳이 있으면 true.
     */
    public boolean inputDown(long nowMs) { return freeze(nowMs).any(); }

    /**
     * 선박 만료를 멈출 곳(계약 v2 §B3 "gap 이 열려 있으면 얼림" · 계약 v4 §D 구역별).
     * <ul>
     *   <li>전체: 수집기 상태 없음/오래됨 · api 가 2분 넘게 ships 메시지를 받지 못함(상태를 모른다) · 구역 정보가 없는데 합계가 열린 공백·끊김 ·
     *       합계는 끊김·공백인데 끊긴 구역이 하나도 없음(어긋남 — 모르는 것으로 본다).</li>
     *   <li>구역: 구역 정보가 있으면 열린 공백이 있거나 연결되지 않은(모름 포함) 구역의 상자 안만 — 다른 구역 선박은 평소처럼 만료한다.</li>
     * </ul>
     */
    public ShipStore.Freeze freeze(long nowMs) {
        Feed f = feed;
        if (!f.heartbeatFresh(nowMs)) return ShipStore.Freeze.ALL;
        long applied = ships.view().appliedAtMs();
        if (applied == 0 || nowMs - applied > STALL_MS) return ShipStore.Freeze.ALL;
        boolean totalDown = f.gapOpenSince() != null || Boolean.FALSE.equals(f.connected());
        if (f.shards() == null) return totalDown ? ShipStore.Freeze.ALL : ShipStore.Freeze.NONE;
        List<AisScope> down = new ArrayList<>();
        for (Shard sh : f.shards()) if (sh.down()) down.add(sh.scope());
        if (down.isEmpty()) return totalDown ? ShipStore.Freeze.ALL : ShipStore.Freeze.NONE;
        return ShipStore.Freeze.of(down);
    }

    /**
     * status.sources.ais(계약 v2 §B3): {connected, lag_s, msgs_per_s, gap_open_since, last_gap:{started_at, ended_at, reason}} +
     * provider · last_msg_at · ships · heartbeat_stale. 값을 모르면 키를 뺀다(null). AIS 를 한 번도 본 적 없으면(수집기 해시도 선박도 없음) null.
     * <ul>
     *   <li>connected: 수집기가 aisstream 에 연결돼 있다고 보고했고 그 보고가 30 s 안(아니면 모름).</li>
     *   <li>lag_s: 지금 − api 가 가진 가장 새 보고의 seen_at(aisstream 수신 시각) — 수집기 연결 끊김과 파이프라인 멈춤을 모두 드러낸다.</li>
     *   <li>msgs_per_s: 수집기의 최근 창 수신률(heartbeat 가 오래됐으면 모름).</li>
     *   <li>last_gap: 가장 최근에 끝난 공백(수집기 해시와 api 가 받은 ais_gap 중 늦게 끝난 것).</li>
     *   <li>state · coverage(계약 v3 §A): 수집기 상태 이름 · 지금 구독한 상자 [[lat1, lon1, lat2, lon2], ...](구역이 있으면 모든 구역 상자의 합) —
     *       connected 처럼 heartbeat 가 30 s 안일 때만(아니면 키 없음 — 죽은 수집기의 마지막 값을 지금 값처럼 말하지 않는다).</li>
     *   <li>shards(계약 v4 §D): 구역마다 {coverage, state, connected, gap_open_since} — heartbeat 가 30 s 안이고 구역 정보가 검증을 통과했을 때만.</li>
     * </ul>
     */
    public Map<String, Object> publicView(long nowMs) {
        Feed f = feed;
        ShipStore.View v = ships.view();
        if (!f.present() && v.appliedAtMs() == 0 && v.size() == 0) return null;
        boolean fresh = f.heartbeatFresh(nowMs);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("connected", f.connectedNow(nowMs));
        m.put("state", fresh ? f.state() : null);
        Instant newest = v.newestSeenAt();
        m.put("lag_s", newest == null ? null : Math.round(Math.max(0, nowMs - newest.toEpochMilli()) / 100.0) / 10.0);
        m.put("msgs_per_s", fresh ? f.msgsPerS() : null);
        m.put("gap_open_since", f.gapOpenSince());
        AisGap lg = later(f.lastGap(), ships.lastGap());
        if (lg != null) {
            Map<String, Object> g = new LinkedHashMap<>();
            g.put("started_at", lg.startedAt());
            g.put("ended_at", lg.endedAt());
            g.put("reason", lg.reason());
            m.put("last_gap", g);
        }
        m.put("provider", f.provider() != null ? f.provider() : v.provider());
        m.put("last_msg_at", f.lastMsgAt());
        m.put("ships", v.size());
        m.put("coverage", fresh ? f.coverage() : null);
        m.put("shards", fresh ? shardsView(f.shards()) : null);
        m.put("heartbeat_stale", !fresh);
        return m;
    }

    /** status.sources.ais.shards 원소(모르는 값은 키 없음). 구역 정보가 없으면 null. */
    static List<Map<String, Object>> shardsView(List<Shard> shards) {
        if (shards == null) return null;
        List<Map<String, Object>> out = new ArrayList<>(shards.size());
        for (Shard sh : shards) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("coverage", sh.scope().coverage());
            m.put("state", sh.state());
            m.put("connected", sh.connected());
            m.put("gap_open_since", sh.gapOpenSince());
            out.add(m);
        }
        return out;
    }

    static AisGap later(AisGap a, AisGap b) {
        if (a == null) return b;
        if (b == null) return a;
        return b.endedAt().isAfter(a.endedAt()) ? b : a;
    }

    private static String text(Map<Object, Object> h, String k) {
        Object v = h.get(k);
        if (v == null) return null;
        String s = String.valueOf(v).strip();
        if (s.isEmpty()) return null;
        return s.length() > TEXT_MAX ? s.substring(0, TEXT_MAX) : s;
    }

    private static Instant time(Map<Object, Object> h, String k) {
        String s = text(h, k);
        return s == null ? null : parseTime(s);
    }

    /** 시간대가 있는 ISO 시각만(없거나 틀리면 null). */
    private static Instant parseTime(String s) {
        try {
            return Instant.parse(s);
        } catch (DateTimeParseException e) {
            try {
                return java.time.OffsetDateTime.parse(s).toInstant();
            } catch (DateTimeParseException e2) {
                return null;
            }
        }
    }

    private static Double number(Map<Object, Object> h, String k) {
        String s = text(h, k);
        if (s == null) return null;
        try {
            double d = Double.parseDouble(s);
            return Double.isFinite(d) && d >= 0 ? d : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
