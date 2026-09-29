package dev.wakeline.portcalls;

import dev.wakeline.domain.ShipStatic;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * 한국 항만 입출항 읽기(ADR-022 개정). 수집기가 항만청 10곳의 KST 날짜별 신고를 모두 받아 둔 DB 색인(port_call · port_call_coverage — V15)을
 * AIS 호출부호로 찾는다 — 선택은 외부 호출도 Redis 임대도 만들지 않는다(예전 선택마다 clsgn 으로 묻던 조회 · 남용 한도 · 임대 wakeline:demand:portcalls ·
 * 캐시 wakeline:portcalls:* 는 없앴다 — 원천이 clsgn 으로 거르지 않아 거의 모든 선박에 틀린 '기록 없음' 을 보였다).
 * <ul>
 *   <li>호출부호 = AIS 정적 보고의 호출부호를 수집기(portcalls.normalize_call_sign)와 같은 규칙으로 — 언어 간 벡터 schemas/vectors/call-sign-cases.v1.json.
 *       정적 정보가 없거나 칸이 비었으면 no_call_sign(not_received — '없음' 이 아니라 '아직 받지 않음'), 형식 밖이면 no_call_sign(unusable).
 *       선명으로는 찾지 않는다(동명 선박을 섞지 않게).</li>
 *   <li>'기록 없음'(none)은 10곳({@link #PORT_AUTHORITIES} — schemas/vectors/port-authorities.v1.json)이 모두 30일 창의 첫날부터 색인돼 있고 꼬리 갱신이
 *       {@value PortCallsInfo#STALE_AFTER_S} s 안일 때만. 아니면 incomplete 와 빈 곳(어느 항만청 · 무엇이) — 색인이 모자란 것을 기록 없음으로 말하지 않는다.</li>
 *   <li>꺼짐: 수집기 heartbeat(wakeline:collector 의 portcalls_index_state · portcalls_index_at)가 {@value #HEARTBEAT_MAX_AGE_S} s 안이고 no_key · fixture ·
 *       operator_off 이면 disabled. heartbeat 가 없거나 오래됐으면 색인만 본다(색인이 오래되면 incomplete 가 된다).</li>
 *   <li>메모리 캐시 {@value #TTL_MS} ms: 범위(모든 선박이 같이) · heartbeat · 호출부호별 기록. 선박을 고른 세션이 여럿이어도 DB 는 호출부호마다
 *       이 간격에 한 번. DB 오류는 error(같은 간격 동안 둔다 — 다시 부딪히지 않게).</li>
 *   <li>로그에는 호출부호 · 오류 종류만.</li>
 * </ul>
 */
@Component
public class PortCallReader {
    private static final Logger log = LoggerFactory.getLogger(PortCallReader.class);
    public static final long TTL_MS = 15_000;
    static final long HEARTBEAT_MAX_AGE_S = 120;
    /** 시계가 어긋나 미래인 갱신 시각은 이만큼까지만 믿는다. */
    static final long FUTURE_SKEW_S = 300;
    static final String HEARTBEAT = "wakeline:collector";
    static final List<String> HEARTBEAT_FIELDS = List.of("portcalls_index_state", "portcalls_index_at");
    static final Map<String, String> DISABLED_STATES = Map.of("no_key", "no_key", "fixture", "fixture", "operator_off", "operator");
    /** 캐시 항목 상한 — 넘으면 만료된 것을 치우고, 그래도 넘으면 비운다. */
    static final int MAX_ENTRIES = 4_096;
    static final int TEXT_MAX = 80;
    static final Pattern CALL_SIGN = Pattern.compile("^[A-Z0-9]{3,7}$");
    static final Pattern PORT_AUTHORITY_CODE = Pattern.compile("^[0-9]{3}$");
    static final Pattern PORT_CODE = Pattern.compile("^[A-Z0-9]{2,10}$");
    static final Set<String> REVISIONS = Set.of("최종", "최초");
    static final ZoneOffset KST = ZoneOffset.ofHours(9);
    /** 색인이 덮는 항만청 10곳(코드 → 이름, 수집기 portcalls.PORT_AUTHORITIES 와 같은 순서 — 시험이 공유 벡터와 비교한다). */
    public static final List<Map.Entry<String, String>> PORT_AUTHORITIES = List.of(
            Map.entry("020", "부산"), Map.entry("030", "인천"), Map.entry("200", "동해"), Map.entry("300", "대산"), Map.entry("500", "군산"),
            Map.entry("610", "목포"), Map.entry("620", "여수"), Map.entry("700", "포항"), Map.entry("810", "마산"), Map.entry("820", "울산"));

    /** 색인 읽기(운영: {@link PortCallIndex} — 시험은 가짜). 실패는 예외(호출자가 error 로 말한다). */
    public interface Source {
        List<PortCallIndex.Coverage> coverage();

        List<PortCallIndex.Row> byCallSign(String callSign, LocalDate from, LocalDate to, int limit);
    }

    private record Memo<T>(T value, long atMs) {}

    private final Source index;
    private final Supplier<List<Object>> heartbeat;
    private final LongSupplier clock;
    private final ConcurrentHashMap<String, Memo<PortCallsInfo>> cache = new ConcurrentHashMap<>();
    private volatile Memo<List<PortCallIndex.Coverage>> coverageMemo;
    private volatile Memo<String> disabledMemo;
    private final Counter hit;
    private final Counter miss;
    private final Counter errors;

    @Autowired
    public PortCallReader(Source index, StringRedisTemplate redis, MeterRegistry meters) {
        this(index, () -> redis.opsForHash().multiGet(HEARTBEAT, new ArrayList<>(HEARTBEAT_FIELDS)), System::currentTimeMillis, meters);
    }

    /** 시험용(다른 패키지의 WS 시험도 쓴다): 색인 · heartbeat 읽기(portcalls_index_state, portcalls_index_at) · 시계를 주입한다. */
    public PortCallReader(Source index, Supplier<List<Object>> heartbeat, LongSupplier clock) {
        this(index, heartbeat, clock, new SimpleMeterRegistry());
    }

    PortCallReader(Source index, Supplier<List<Object>> heartbeat, LongSupplier clock, MeterRegistry meters) {
        this.index = index;
        this.heartbeat = heartbeat;
        this.clock = clock;
        this.hit = Counter.builder("wakeline_cache_requests_total").tag("cache", "portcalls").tag("result", "hit").register(meters);
        this.miss = Counter.builder("wakeline_cache_requests_total").tag("cache", "portcalls").tag("result", "miss").register(meters);
        this.errors = Counter.builder("wakeline_portcall_index_errors_total").description("입출항 색인(DB)을 읽지 못한 수 — 카드는 error").register(meters);
    }

    /** 이 선박 정적 정보의 호출부호로 찾은 입출항. 정적 정보가 없거나 호출부호 칸이 비었으면 no_call_sign(not_received — 아직 받지 않음). */
    public PortCallsInfo forStatic(ShipStatic st) {
        String raw = st == null ? null : st.callSign();
        if (raw == null || raw.isBlank()) return PortCallsInfo.noCallSign(PortCallsInfo.NOT_RECEIVED);
        String cs = normalizeCallSign(raw);
        return cs == null ? PortCallsInfo.noCallSign(PortCallsInfo.UNUSABLE) : forCallSign(cs);
    }

    /** 정규화한 호출부호 → 입출항({@value #TTL_MS} ms 메모리 캐시). */
    public PortCallsInfo forCallSign(String cs) {
        if (cs == null || !CALL_SIGN.matcher(cs).matches()) return PortCallsInfo.noCallSign(PortCallsInfo.UNUSABLE);
        long now = clock.getAsLong();
        Memo<PortCallsInfo> e = cache.get(cs);
        if (fresh(e, now)) {
            hit.increment();
            return e.value();
        }
        miss.increment();
        PortCallsInfo info = read(cs, now);
        if (cache.size() >= MAX_ENTRIES) prune(now);
        cache.put(cs, new Memo<>(info, now));
        return info;
    }

    private static boolean fresh(Memo<?> m, long now) { return m != null && now >= m.atMs() && now - m.atMs() < TTL_MS; }

    private PortCallsInfo read(String cs, long nowMs) {
        String off = disabledReason(nowMs);
        if (off != null) return PortCallsInfo.disabled(cs, off);
        Instant now = Instant.ofEpochMilli(nowMs);
        LocalDate to = now.atOffset(KST).toLocalDate(), from = to.minusDays(PortCallsInfo.WINDOW_DAYS);
        List<PortCallIndex.Coverage> cov;
        List<PortCallIndex.Row> rows;
        try {
            cov = coverage(nowMs);
            rows = index.byCallSign(cs, from, to, PortCallsInfo.MAX_ITEMS + 1);
        } catch (RuntimeException ex) {
            errors.increment();
            log.debug("port-call index unavailable for {}: {}", cs, ex.getClass().getSimpleName());
            return PortCallsInfo.error(cs);
        }
        List<PortCallsInfo.PortCall> items = new ArrayList<>();
        for (PortCallIndex.Row r : rows) {
            if (items.size() == PortCallsInfo.MAX_ITEMS) break;
            if (cs.equals(r.callSign())) items.add(item(r)); // 색인도 믿지 않는다 — 다른 호출부호의 행은 이 선박의 기록이 아니다
        }
        return PortCallsInfo.found(cs, from.toString(), to.toString(), items, rows.size() > PortCallsInfo.MAX_ITEMS, summarize(cov, from, now));
    }

    private List<PortCallIndex.Coverage> coverage(long nowMs) {
        Memo<List<PortCallIndex.Coverage>> m = coverageMemo;
        if (fresh(m, nowMs)) return m.value();
        List<PortCallIndex.Coverage> c = List.copyOf(index.coverage());
        coverageMemo = new Memo<>(c, nowMs);
        return c;
    }

    /** 수집기가 색인을 끈 까닭(no_key · fixture · operator) — heartbeat 가 없거나 오래됐거나 읽지 못하면 null(색인만 본다). */
    String disabledReason(long nowMs) {
        Memo<String> m = disabledMemo;
        if (fresh(m, nowMs)) return m.value();
        String reason = null;
        try {
            List<Object> v = heartbeat.get();
            Object state = v == null || v.isEmpty() ? null : v.get(0);
            Instant at = v == null || v.size() < 2 ? null : iso(v.get(1));
            boolean hbFresh = at != null && Math.abs(Duration.between(at, Instant.ofEpochMilli(nowMs)).toSeconds()) <= HEARTBEAT_MAX_AGE_S;
            if (hbFresh && state != null) reason = DISABLED_STATES.get(state.toString());
        } catch (RuntimeException e) {
            log.debug("collector heartbeat unreadable: {}", e.getClass().getSimpleName());
        }
        disabledMemo = new Memo<>(reason, nowMs);
        return reason;
    }

    /**
     * 범위 → 색인 상태. 항만청마다: 행이 없으면 not_indexed · 창 첫날(from)보다 늦게 시작하면 partial · 꼬리 갱신이 없거나 {@value PortCallsInfo#STALE_AFTER_S} s 넘게
     * 지났거나(미래로 {@value #FUTURE_SKEW_S} s 넘게 어긋나도) 범위 끝이 그 갱신의 KST 날짜보다 앞서면 stale. 빈 곳이 없어야 complete.
     */
    static PortCallsInfo.Index summarize(List<PortCallIndex.Coverage> coverage, LocalDate from, Instant now) {
        Map<String, PortCallIndex.Coverage> byCode = new HashMap<>();
        for (PortCallIndex.Coverage c : coverage) if (c != null && c.portAuthority() != null) byCode.put(c.portAuthority(), c);
        List<PortCallsInfo.Gap> gaps = new ArrayList<>();
        Instant oldest = null;
        boolean allRefreshed = true;
        for (Map.Entry<String, String> pa : PORT_AUTHORITIES) {
            PortCallIndex.Coverage c = byCode.get(pa.getKey());
            if (c == null || c.coveredFrom() == null || c.coveredTo() == null) {
                gaps.add(new PortCallsInfo.Gap(pa.getKey(), pa.getValue(), List.of(PortCallsInfo.NOT_INDEXED), null, null, null));
                allRefreshed = false;
                continue;
            }
            List<String> issues = new ArrayList<>(2);
            if (c.coveredFrom().isAfter(from)) issues.add(PortCallsInfo.PARTIAL);
            Instant r = c.refreshedAt();
            boolean stale = r == null || Duration.between(r, now).toSeconds() > PortCallsInfo.STALE_AFTER_S
                    || Duration.between(now, r).toSeconds() > FUTURE_SKEW_S || c.coveredTo().isBefore(r.atOffset(KST).toLocalDate());
            if (stale) issues.add(PortCallsInfo.STALE);
            if (r == null) allRefreshed = false;
            else if (oldest == null || r.isBefore(oldest)) oldest = r;
            if (!issues.isEmpty())
                gaps.add(new PortCallsInfo.Gap(pa.getKey(), pa.getValue(), List.copyOf(issues), c.coveredFrom().toString(), c.coveredTo().toString(), r));
        }
        return new PortCallsInfo.Index(PORT_AUTHORITIES.size(), gaps.isEmpty(), allRefreshed ? oldest : null, PortCallsInfo.STALE_AFTER_S, List.copyOf(gaps));
    }

    /** 행 → 화면 항목. 색인도 다시 검사한다(코드 모양 · 제어 · 서식 문자 · 길이 · 알려진 판 이름만). */
    static PortCallsInfo.PortCall item(PortCallIndex.Row r) {
        Instant entry = r.entryAt(), exit = r.exitAt();
        return new PortCallsInfo.PortCall(code(r.portAuthorityCode(), PORT_AUTHORITY_CODE), text(r.portAuthority()),
                r.listedDate() == null ? null : r.listedDate().toString(), entry, entry == null ? null : revision(r.entryRevision()), exit,
                exit == null ? null : revision(r.exitRevision()), text(r.berth()), text(r.purpose()), port(r.firstPortCode(), r.firstPortName()),
                port(r.prevPortCode(), r.prevPortName()), port(r.nextPortCode(), r.nextPortName()), port(r.destPortCode(), r.destPortName()),
                text(r.reportedName()), text(r.kind()), text(r.nationality()), r.fetchedAt());
    }

    static PortCallsInfo.Port port(String code, String name) {
        String c = code(code, PORT_CODE), n = text(name);
        return c == null && n == null ? null : new PortCallsInfo.Port(c, n);
    }

    private static String revision(String v) { return v != null && REVISIONS.contains(v) ? v : null; }

    private static String code(String v, Pattern p) { return v != null && p.matcher(v).matches() ? v : null; }

    /** 문자열: 제어 · 서식 문자 제거 → 앞뒤 공백 제거 → {@value #TEXT_MAX} 코드포인트로 절단(RouteInfo.text 와 같은 규칙). 비면 null. */
    static String text(String s) {
        if (s == null) return null;
        StringBuilder b = new StringBuilder(Math.min(s.length(), TEXT_MAX + 8));
        s.codePoints().filter(cp -> {
            int t = Character.getType(cp);
            return t != Character.CONTROL && t != Character.FORMAT;
        }).forEach(b::appendCodePoint);
        String out = b.toString().strip();
        if (out.codePointCount(0, out.length()) > TEXT_MAX) out = out.substring(0, out.offsetByCodePoints(0, TEXT_MAX)).strip();
        return out.isEmpty() ? null : out;
    }

    private static Instant iso(Object v) {
        if (v == null) return null;
        try {
            return OffsetDateTime.parse(v.toString().trim()).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private void prune(long now) {
        cache.values().removeIf(e -> !fresh(e, now));
        if (cache.size() >= MAX_ENTRIES) cache.clear();
    }

    int cached() { return cache.size(); }

    /**
     * 호출부호 정규화(수집기 portcalls.normalize_call_sign 과 같다): ASCII 가 아니면 null(문자열 전체 — 앞뒤 공백 포함, 대문자 변환 전) →
     * 앞뒤 공백 제거 → 대문자 → {@code ^[A-Z0-9]{3,7}$} 이면 그 값, 아니면 null. 가운데 공백·기호는 지우지 않는다(다른 호출부호로 바꿔 찾지 않는다).
     */
    public static String normalizeCallSign(String raw) {
        if (raw == null) return null;
        for (int i = 0; i < raw.length(); i++) if (raw.charAt(i) >= 0x80) return null;
        String cs = raw.strip().toUpperCase(Locale.ROOT);
        return CALL_SIGN.matcher(cs).matches() ? cs : null;
    }
}
