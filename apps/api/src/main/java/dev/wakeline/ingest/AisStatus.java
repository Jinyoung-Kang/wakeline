package dev.wakeline.ingest;

import dev.wakeline.domain.AisBboxes;
import dev.wakeline.domain.AisGap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

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

    /**
     * 검증한 상태 해시. present = 해시가 있었다. connected 는 수집기 보고값 그대로(지금 값인지는 {@link #connectedNow}).
     * state = 알려진 상태 이름만(아니면 null). coverage = 수집기가 지금 구독한 상자 [[lat1, lon1, lat2, lon2], ...](형식 오류·빈 값이면 null).
     */
    public record Feed(boolean present, String provider, Boolean connected, Instant updatedAt, Instant lastMsgAt, Double msgsPerS,
                       Instant gapOpenSince, String gapReason, AisGap lastGap, String state, List<List<Double>> coverage) {
        static final Feed ABSENT = new Feed(false, null, null, null, null, null, null, null, null, null, null);

        /** heartbeat 가 최근인가(미래로 1분 넘게 틀어진 시각도 믿지 않는다). */
        public boolean heartbeatFresh(long nowMs) {
            if (updatedAt == null) return false;
            long t = updatedAt.toEpochMilli();
            return nowMs - t <= HEARTBEAT_MAX_AGE_MS && t - nowMs <= 60_000;
        }

        /** 지금의 연결 상태 — heartbeat 가 오래됐으면 null(모름). */
        public Boolean connectedNow(long nowMs) { return heartbeatFresh(nowMs) ? connected : null; }
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
        String state = text(h, "state");
        return new Feed(true, provider, connected, time(h, "updated_at"), time(h, "last_msg_at"), number(h, "msgs_per_s"),
                time(h, "gap_open_since"), text(h, "gap_reason"), last, state != null && STATES.contains(state) ? state : null, coverage(h.get("bbox")));
    }

    /**
     * 상태 해시의 bbox(수집기가 지금 구독한 영역, ais/bbox.py format_bboxes 의 정규화 문자열) → [[lat1, lon1, lat2, lon2], ...].
     * 운영 설정과 같은 규칙({@link AisBboxes})을 통과한 값만 — 비었거나(구독 전·비활성) 형식이 틀리면 null(범위를 추정해 그리지 않는다).
     */
    static List<List<Double>> coverage(Object raw) {
        if (raw == null) return null;
        String s = String.valueOf(raw).strip();
        if (s.isEmpty()) return null;
        try {
            List<List<Double>> out = new ArrayList<>();
            for (double[] b : AisBboxes.parse(s)) out.add(List.of(b[0], b[1], b[2], b[3]));
            return List.copyOf(out);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /**
     * 수신이 끊겼거나 확인할 수 없는가 — 그동안은 선박을 만료시키지 않는다(계약 v2 §B3 "gap 이 열려 있으면 얼림").
     * 열린 공백 · 수집기 상태 없음/오래됨 · 수집기가 끊김을 보고 · api 가 2분 넘게 ships 메시지를 받지 못함.
     */
    public boolean inputDown(long nowMs) {
        Feed f = feed;
        if (f.gapOpenSince() != null || !f.heartbeatFresh(nowMs) || Boolean.FALSE.equals(f.connected())) return true;
        long applied = ships.view().appliedAtMs();
        return applied == 0 || nowMs - applied > STALL_MS;
    }

    /**
     * status.sources.ais(계약 v2 §B3): {connected, lag_s, msgs_per_s, gap_open_since, last_gap:{started_at, ended_at, reason}} +
     * provider · last_msg_at · ships · heartbeat_stale. 값을 모르면 키를 뺀다(null). AIS 를 한 번도 본 적 없으면(수집기 해시도 선박도 없음) null.
     * <ul>
     *   <li>connected: 수집기가 aisstream 에 연결돼 있다고 보고했고 그 보고가 30 s 안(아니면 모름).</li>
     *   <li>lag_s: 지금 − api 가 가진 가장 새 보고의 seen_at(aisstream 수신 시각) — 수집기 연결 끊김과 파이프라인 멈춤을 모두 드러낸다.</li>
     *   <li>msgs_per_s: 수집기의 최근 창 수신률(heartbeat 가 오래됐으면 모름).</li>
     *   <li>last_gap: 가장 최근에 끝난 공백(수집기 해시와 api 가 받은 ais_gap 중 늦게 끝난 것).</li>
     *   <li>state · coverage(계약 v3 §A): 수집기 상태 이름 · 지금 구독한 상자 [[lat1, lon1, lat2, lon2], ...] — connected 처럼 heartbeat 가
     *       30 s 안일 때만(아니면 키 없음 — 죽은 수집기의 마지막 값을 지금 값처럼 말하지 않는다).</li>
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
        m.put("heartbeat_stale", !fresh);
        return m;
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
        if (s == null) return null;
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
