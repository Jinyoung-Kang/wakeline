package dev.wakeline.ws;

import dev.wakeline.demand.CollectorDemandStatus;
import dev.wakeline.demand.DemandLeases;
import dev.wakeline.demand.DemandStats;
import dev.wakeline.domain.AircraftState;
import dev.wakeline.geo.Bbox;
import dev.wakeline.geo.Geo;
import dev.wakeline.domain.HotCell;
import dev.wakeline.ingest.SnapshotStore;
import dev.wakeline.ops.RegionSettings;
import dev.wakeline.route.RouteReader;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * 수요 기반 정밀 추적의 서버 쪽(ADR-013, 계약 v2 §A1·§A3). 브라우저는 지역·주기를 요청하지 못한다 — api 가 WS 세션의 뷰포트·선택으로
 * 수요를 계산해 Redis 임대로 쓰고, 수집기(유일한 외부 호출자)가 임대만 읽어 조회한다.
 * <ul>
 *   <li>대상: 살아 있고 일시정지하지 않은 구독 세션. 선택 항공기가 있으면 집중 추적(focus) 수요만 — 핫 리전 수요는 내지 않는다.
 *       항공기 레이어를 끈 세션({type:"layers", aircraft:false})은 핫 리전 수요를 내지 않는다.
 *       선택이 없고 줌 ≥ 7 이며 화면 중심이 고정 관심 지역 원 밖이면 핫 리전(hot) 수요(셀 키는 {@link HotCell#forViewport}).
 *       원 안이면 covered_by_region(임대 없음). 같은 hex·셀은 세션끼리 임대 하나를 나눈다.</li>
 *   <li>한 세션이 같은 hex 를 30분 넘게 연속 선택하면(비용 상한) 수요를 내지 않고 expired_session_cap 을 알린다. 다시 선택하면 새로 시작.</li>
 *   <li>상한: hot 6 셀 · focus 50 hex(세션 수 많은 순 → 먼저 요청된 순). 상한 밖 세션에는 throttled.</li>
 *   <li>focus 메타의 callsign(계약 v4 §G A-1): 화면이 보는 병합 뷰의 그 hex 콜사인을 노선 읽기와 같은 규칙({@link RouteReader#normalizeCallsign})으로
 *       정규화한 값 — 수집기는 이 콜사인으로 노선을 조회한다(api 가 읽는 캐시 키와 같다). 콜사인을 모르거나 형식이 틀리면 키 없음.</li>
 *   <li>세션 제한(계약 v3 §C — 남용 방지): 한 세션이 새로 올리는 hex·셀은 60 s 창에 각각 6개까지만 임대에 반영한다. 넘으면 그 세션의 직전
 *       임대를 그대로 두고(새 키 무시) 그 항목에 limited 를 알린다. 연결은 끊지 않는다. 키를 빼는 변화(선택 해제·줌 아웃)는 언제나 반영한다.</li>
 *   <li>주기: 10 s 마다 + 구독·선택·일시정지·종료 뒤 1 s 로 모아(debounce) 다시 계산한다. 임대 만료는 60 s — api 가 멈춰도 수집기 호출은
 *       60 s 안에 멈춘다. 수요가 없어진 임대는 다음 계산(≤ 1 s)에서 바로 지운다(선택 해제·창 닫기).</li>
 *   <li>상태: 수집기가 쓴 wakeline:demand:status 를 읽어 세션마다 {type:"demand"} 를 바뀌었을 때와 30 s 마다 보낸다. 수집기가 보고하지
 *       않은 주기는 말하지 않는다(pending 은 interval 없음). 오래된 active 는 믿지 않는다({@link CollectorDemandStatus#activeAt}).</li>
 *   <li>스레드: 전용 스레드 하나(계산·Redis I/O). WS 수신·스트림 소비·팬아웃 스레드는 기다리지 않는다 — 신호만 보낸다.</li>
 *   <li>선박 선택은 수요를 만들지 않는다: 한국 항만 입출항은 수집기가 미리 만든 DB 색인을 api 가 읽는다(ADR-022 개정 — 예전의 선택 선박 호출부호
 *       임대 wakeline:demand:portcalls · 세션/IP 남용 한도는 없앴다. 원천이 clsgn 으로 거르지 않아 선택마다 묻는 설계가 틀린 '기록 없음' 을 보였다).</li>
 * </ul>
 */
@Profile("!cli & !migrate")
@Component
public class DemandService implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(DemandService.class);
    static final long REFRESH_MS = 10_000;
    static final long DEBOUNCE_MS = 1_000;
    static final long PUSH_EVERY_MS = 30_000;
    static final long LEASE_TTL_MS = 60_000;
    public static final long FOCUS_SESSION_CAP_MS = 30 * 60_000L;
    public static final int HOT_MIN_ZOOM = 7;
    public static final int MAX_HOT_CELLS = 6;
    public static final int MAX_FOCUS_HEXES = 50;
    /** 세션 제한(계약 v3 §C): 새 hex·새 셀은 각각 이 창(60 s)에 이 수(6)까지. */
    public static final int SESSION_NEW_KEYS_MAX = 6;
    public static final long SESSION_NEW_KEYS_WINDOW_MS = 60_000;
    static final long STOP_WAIT_MS = 2_000;

    enum Kind { NONE, HOT, COVERED, FOCUS, FOCUS_CAPPED }

    /** 세션 하나의 수요. key = 셀 키(HOT) 또는 hex(FOCUS·FOCUS_CAPPED). */
    record Want(WsSession session, Kind kind, String key, HotCell cell, long sinceMs) {}

    /** 세션이 지금 임대에 올린 수요(HOT 또는 FOCUS) — 세션 제한에 걸리면 이것을 유지한다. */
    record Held(Kind kind, String key, HotCell cell) {}

    private final WsHub hub;
    private final Supplier<RegionSettings.Region> region;
    private final SnapshotStore snapshots;
    private final DemandLeases leases;
    private final DemandStats stats;
    private final ObjectMapper json;
    private final ScheduledExecutorService exec;
    private final LongSupplier clock;
    private final AtomicBoolean refreshQueued = new AtomicBoolean();
    private final Timer refreshTimer;
    private final Counter writeErrors;
    private final Counter statusErrors;
    private final Counter refreshErrors;
    private volatile boolean running;
    private ScheduledFuture<?> periodic;
    // ---- 수요 스레드 전용 ----
    private final Map<String, Long> hotFirstAt = new HashMap<>();
    private final Map<String, Long> focusFirstAt = new HashMap<>();
    private long lastWarnMs;

    @Autowired
    public DemandService(WsHub hub, RegionSettings region, SnapshotStore snapshots, DemandLeases leases, DemandStats stats,
                         ObjectMapper json, MeterRegistry meters) {
        this(hub, region::current, snapshots, leases, stats, json, meters,
                Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("demand").factory()), System::currentTimeMillis);
    }

    /** 테스트용: 실행기·시계·지역을 주입한다. */
    DemandService(WsHub hub, Supplier<RegionSettings.Region> region, SnapshotStore snapshots, DemandLeases leases, DemandStats stats,
                  ObjectMapper json, MeterRegistry meters, ScheduledExecutorService exec, LongSupplier clock) {
        this.hub = hub;
        this.region = region;
        this.snapshots = snapshots;
        this.leases = leases;
        this.stats = stats;
        this.json = json;
        this.exec = exec;
        this.clock = clock;
        this.refreshTimer = Timer.builder("wakeline_demand_refresh_seconds").description("수요 계산 한 번(임대 쓰기·상태 읽기 포함)").register(meters);
        this.writeErrors = Counter.builder("wakeline_demand_errors_total").tag("op", "write").register(meters);
        this.statusErrors = Counter.builder("wakeline_demand_errors_total").tag("op", "status").register(meters);
        this.refreshErrors = Counter.builder("wakeline_demand_errors_total").tag("op", "refresh").register(meters);
        meters.gauge("wakeline_demand_leases", List.of(io.micrometer.core.instrument.Tag.of("kind", "hot")), stats, s -> s.counts().hotLeased());
        meters.gauge("wakeline_demand_leases", List.of(io.micrometer.core.instrument.Tag.of("kind", "focus")), stats, s -> s.counts().focusLeased());
        meters.gauge("wakeline_demand_wanted", List.of(io.micrometer.core.instrument.Tag.of("kind", "hot")), stats, s -> s.counts().hotWanted());
        meters.gauge("wakeline_demand_wanted", List.of(io.micrometer.core.instrument.Tag.of("kind", "focus")), stats, s -> s.counts().focusWanted());
        hub.setDemandListener(this::requestRefresh);
    }

    // ---- 수명 ----

    /** 10 s 주기 시작. 기동 직후에는 세션이 없다 — 재접속하는 세션의 구독이 1 s 모음으로 첫 계산을 부른다. */
    @Override
    public void start() {
        running = true;
        periodic = exec.scheduleWithFixedDelay(this::refreshSafe, REFRESH_MS, REFRESH_MS, TimeUnit.MILLISECONDS);
    }

    /**
     * WS 허브(모든 세션 종료)보다 뒤에 멈춘다. 마지막으로 빈 임대를 써서 수집기 호출을 바로 멈춘다(실패해도 60 s 안에 만료).
     */
    @Override
    public void stop() {
        running = false;
        if (periodic != null) periodic.cancel(false);
        try {
            Future<?> f = exec.submit(() -> {
                try {
                    leases.replace(List.of(), List.of(), clock.getAsLong());
                } catch (RuntimeException e) {
                    log.info("demand leases not cleared on shutdown (they expire within {} s): {}", LEASE_TTL_MS / 1000, e.toString());
                }
            });
            f.get(STOP_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            log.debug("demand stop: {}", e.toString());
        } finally {
            exec.shutdownNow();
        }
    }

    @Override public boolean isRunning() { return running; }

    /** WS 허브(MAX-100)보다 늦게 멈추고 Redis 연결(0)보다 먼저 멈춘다. */
    @Override public int getPhase() { return Integer.MAX_VALUE - 150; }

    /** 수요가 바뀌었다 — 1 s 뒤 한 번(그 사이의 변화는 합친다). 호출자는 기다리지 않는다. */
    void requestRefresh() {
        if (!running || !refreshQueued.compareAndSet(false, true)) return;
        try {
            exec.schedule(() -> {
                refreshQueued.set(false);
                refreshSafe();
            }, DEBOUNCE_MS, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            refreshQueued.set(false);
        }
    }

    /** 예외가 주기 작업을 멈추지 않게(ScheduledExecutorService 는 예외 뒤 반복을 취소한다). */
    void refreshSafe() {
        try {
            refresh(clock.getAsLong());
        } catch (RuntimeException e) {
            refreshErrors.increment();
            warn("demand refresh failed: {}", e);
        }
    }

    // ---- 계산 ----

    /** 한 번 계산: 세션 → 수요 → 상한 → 임대 교체 → 상태 읽기 → 세션별 demand 메시지. 수요 스레드에서만. */
    void refresh(long nowMs) {
        long t0 = System.nanoTime();
        RegionSettings.Region reg = region.get();
        List<Want> wants = new ArrayList<>();
        for (WsSession s : hub.sessionsView()) {
            if (s.subscribed()) {
                wants.add(want(s, reg, nowMs));
            } else {
                s.demandHeld = null; // 보지 않는 세션은 임대에 아무것도 올리지 않는다(다시 보면 새 키로 센다)
                if (s.demandJson != null) {
                    // 일시정지(보지 않음) — 수요를 내지 않으므로 마지막 상태를 버린다: 다시 볼 때(resume) 초기 세트가 지난 'active' 를
                    // 되풀이하지 않고, 다음 계산의 새 상태를 바로 보낸다
                    s.demandJson = null;
                    s.demandQueuedJson = null;
                }
            }
        }

        // 임대에 올리는 것은 세션 제한을 거친 수요(demandHeld) — 제한에 걸린 세션은 직전 임대를 유지한다
        Map<String, Integer> hotCount = new LinkedHashMap<>(), focusCount = new LinkedHashMap<>();
        Map<String, HotCell> cells = new HashMap<>();
        Set<WsSession> limited = new HashSet<>();
        for (Want w : wants) {
            if (!admit(w, nowMs)) limited.add(w.session());
            Held h = w.session().demandHeld;
            if (h == null) continue;
            if (h.kind() == Kind.HOT) {
                hotCount.merge(h.key(), 1, Integer::sum);
                cells.putIfAbsent(h.key(), h.cell());
            } else {
                focusCount.merge(h.key(), 1, Integer::sum);
            }
        }
        List<String> hot = choose(hotCount, hotFirstAt, MAX_HOT_CELLS, nowMs);
        List<String> focus = choose(focusCount, focusFirstAt, MAX_FOCUS_HEXES, nowMs);

        List<DemandLeases.Lease> hotLeases = new ArrayList<>(hot.size());
        for (String k : hot) hotLeases.add(new DemandLeases.Lease(k, hotMeta(cells.get(k), hotCount.get(k), hotFirstAt.get(k))));
        List<DemandLeases.Lease> focusLeases = new ArrayList<>(focus.size());
        Map<String, AircraftState> live = focus.isEmpty() ? Map.of() : snapshots.merged(Instant.ofEpochMilli(nowMs));
        for (String h : focus) focusLeases.add(new DemandLeases.Lease(h, focusMeta(focusCount.get(h), focusFirstAt.get(h), live.get(h))));
        try {
            leases.replace(hotLeases, focusLeases, nowMs + LEASE_TTL_MS);
        } catch (RuntimeException e) {
            writeErrors.increment();
            warn("demand lease write failed (collector keeps the previous leases until they expire): {}", e);
        }
        Set<String> hotSet = Set.copyOf(hot), focusSet = Set.copyOf(focus);
        if (snapshots.setLeases(hotSet, focusSet)) hub.fanoutAll(); // 선택 해제된 hex 의 focus 관측이 빠졌다 — 화면을 병합 뷰에 맞춘다

        Map<String, CollectorDemandStatus> st = readStatus(hot, focus);
        int hotActive = 0, focusActive = 0;
        for (String k : hot) if (isActive(st.get("hot:" + k), nowMs)) hotActive++;
        for (String h : focus) if (isActive(st.get("focus:" + h), nowMs)) focusActive++;

        for (Want w : wants) {
            WsSession s = w.session();
            String j = hub.toJson(message(w, limited.contains(s), hotSet, focusSet, st, nowMs));
            s.demandJson = j;
            if (!j.equals(s.demandQueuedJson) || nowMs - s.demandQueuedAtMs >= PUSH_EVERY_MS) {
                s.demandQueuedJson = j;
                s.demandQueuedAtMs = nowMs;
                hub.pushDemand(s);
            }
        }
        stats.update(new DemandStats.Counts(hotActive, focusActive, hot.size(), focus.size(), hotCount.size(), focusCount.size()));
        refreshTimer.record(Duration.ofNanos(System.nanoTime() - t0));
    }

    /** 세션 하나의 수요(계약 v2 §A1). */
    static Want want(WsSession s, RegionSettings.Region reg, long nowMs) {
        WsSession.Selection sel = s.selection; // 한 번 읽는다 — hex 와 선택 시각이 같은 select 의 것이다
        if (sel != null) {
            long since = sel.atMs;
            return new Want(s, nowMs - since >= FOCUS_SESSION_CAP_MS ? Kind.FOCUS_CAPPED : Kind.FOCUS, sel.hex, null, since);
        }
        WsSession.Sub sub = s.sub;
        // 항공기 레이어를 끈 세션은 항공기를 보고 있지 않다 — 핫 리전 호출을 쓰지 않는다(선택 항공기의 집중 추적은 명시적 선택이라 위에서 그대로)
        if (sub == null || sub.zoom() < HOT_MIN_ZOOM || !s.layerAircraft) return new Want(s, Kind.NONE, null, null, 0);
        Bbox b = sub.bbox();
        double clat = (b.lamin() + b.lamax()) / 2.0, clon = (b.lomin() + b.lomax()) / 2.0;
        if (reg != null && Geo.haversineNm(reg.lat(), reg.lon(), clat, clon) <= reg.radiusNm()) return new Want(s, Kind.COVERED, null, null, 0);
        HotCell cell = HotCell.forViewport(b);
        if (cell == null) return new Want(s, Kind.NONE, null, null, 0);
        return new Want(s, Kind.HOT, cell.key(), cell, 0);
    }

    /**
     * 세션 제한(계약 v3 §C): 수요를 세션의 임대(demandHeld)에 반영하고 true. 직전 임대에 없던 키(새 hex·새 셀)는 종류별 60 s 창에
     * 6개까지만 — 넘으면 같은 종류의 직전 임대는 그대로 두고 false(limited). 종류가 바뀌는 변화(선택·선택 해제)였다면 직전 키는 빼고 새 키만
     * 막는다. 같은 키 유지·키 빼기(NONE·COVERED·30분 상한)는 언제나 반영한다.
     * 거절한 시도는 창에 기록하지 않는다 — 창이 비면 다음 계산(≤ 10 s)에 반영된다.
     */
    static boolean admit(Want w, long nowMs) {
        WsSession s = w.session();
        Held next = switch (w.kind()) {
            case HOT -> new Held(Kind.HOT, w.key(), w.cell());
            case FOCUS -> new Held(Kind.FOCUS, w.key(), null);
            case NONE, COVERED, FOCUS_CAPPED -> null;
        };
        Held prev = s.demandHeld;
        boolean fresh = next != null && (prev == null || prev.kind() != next.kind() || !prev.key().equals(next.key()));
        if (fresh) {
            SlidingWindowLimiter newKeys = next.kind() == Kind.HOT ? s.newHotKeys : s.newFocusKeys;
            if (!newKeys.tryAcquire(TimeUnit.MILLISECONDS.toNanos(nowMs))) {
                // 종류가 바뀌는 변화(선택 해제: FOCUS→HOT, 선택: HOT→FOCUS)는 직전 키를 더 원하지 않는다는 뜻이다 — 빼기는 반영하고
                // 새 키만 막는다. 그래야 한도가 찬 세션이 선택을 해제해도 아무도 보지 않는 항공기를 계속 조회하지 않는다.
                if (prev != null && prev.kind() != next.kind()) s.demandHeld = null;
                return false;
            }
        }
        s.demandHeld = next;
        return true;
    }

    /**
     * 상한 안에서 임대할 키: 세션 수 많은 순 → 먼저 요청된 순 → 키 순(결정적). firstAt 은 계속 요청되는 동안 유지하고, 사라진 키는 지운다.
     */
    static List<String> choose(Map<String, Integer> counts, Map<String, Long> firstAt, int cap, long nowMs) {
        firstAt.keySet().retainAll(counts.keySet());
        for (String k : counts.keySet()) firstAt.putIfAbsent(k, nowMs);
        List<String> keys = new ArrayList<>(counts.keySet());
        keys.sort(Comparator.<String>comparingInt(k -> -counts.get(k)).thenComparingLong(firstAt::get).thenComparing(Comparator.naturalOrder()));
        return keys.size() > cap ? List.copyOf(keys.subList(0, cap)) : List.copyOf(keys);
    }

    private String hotMeta(HotCell c, int sessions, long firstAtMs) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("lat", c.lat());
        m.put("lon", c.lon());
        m.put("radius_nm", c.radiusNm());
        m.put("sessions", sessions);
        m.put("first_at", Instant.ofEpochMilli(firstAtMs).toString());
        return json.writeValueAsString(m);
    }

    /** focus 메타 {sessions, first_at, callsign?} — callsign 은 지금 보이는 상태의 콜사인을 정규화한 값(모르면 키 없음). */
    private String focusMeta(int sessions, long firstAtMs, AircraftState live) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("sessions", sessions);
        m.put("first_at", Instant.ofEpochMilli(firstAtMs).toString());
        String callsign = live == null ? null : RouteReader.normalizeCallsign(live.callsign());
        if (callsign != null) m.put("callsign", callsign);
        return json.writeValueAsString(m);
    }

    private Map<String, CollectorDemandStatus> readStatus(List<String> hot, List<String> focus) {
        List<String> fields = new ArrayList<>(hot.size() + focus.size());
        for (String k : hot) fields.add("hot:" + k);
        for (String h : focus) fields.add("focus:" + h);
        if (fields.isEmpty()) return Map.of();
        Map<String, String> raw;
        try {
            raw = leases.status(fields);
        } catch (RuntimeException e) {
            statusErrors.increment();
            warn("demand status read failed (sessions see 'pending'): {}", e);
            return Map.of();
        }
        Map<String, CollectorDemandStatus> out = new HashMap<>();
        for (var e : raw.entrySet()) {
            CollectorDemandStatus c = CollectorDemandStatus.parse(e.getValue(), json);
            if (c != null) out.put(e.getKey(), c);
        }
        return out;
    }

    private static boolean isActive(CollectorDemandStatus c, long nowMs) { return c != null && c.activeAt(nowMs); }

    /**
     * 세션 하나의 demand 메시지. 수집기 상태 → 화면 상태: active(최근 성공) · throttled · not_found · error 는 그대로, 오래된 active 나
     * 보고 없음은 pending(주기 없음). 임대 상한 밖은 throttled(주기 없음). 핫 리전의 not_found 는 수집기가 쓰지 않는 값 — pending.
     * 세션 제한에 걸린 새 키(limited)는 임대에 올리지 않았으므로 limited(주기 없음).
     */
    static WsMessages.DemandMsg message(Want w, boolean limited, Set<String> hotLeased, Set<String> focusLeased,
                                        Map<String, CollectorDemandStatus> st, long nowMs) {
        return switch (w.kind()) {
            case NONE -> new WsMessages.DemandMsg("demand", null, null);
            case COVERED -> new WsMessages.DemandMsg("demand", new WsMessages.HotDemand(null, null, "covered_by_region", null, null), null);
            case HOT -> {
                HotCell c = w.cell();
                if (limited)
                    yield new WsMessages.DemandMsg("demand", new WsMessages.HotDemand(w.key(), c.radiusNm(), "limited", null, null), null);
                if (!hotLeased.contains(w.key()))
                    yield new WsMessages.DemandMsg("demand", new WsMessages.HotDemand(w.key(), c.radiusNm(), "throttled", null, null), null);
                CollectorDemandStatus cs = st.get("hot:" + w.key());
                String state = stateOf(cs, nowMs, Set.of("throttled", "error", "disabled"));
                boolean known = !"pending".equals(state);
                yield new WsMessages.DemandMsg("demand", new WsMessages.HotDemand(w.key(), c.radiusNm(), state,
                        known ? cs.intervalS() : null, cs == null ? null : cs.lastSuccessAt()), null);
            }
            case FOCUS -> {
                Instant since = Instant.ofEpochMilli(w.sinceMs());
                if (limited)
                    yield new WsMessages.DemandMsg("demand", null, new WsMessages.FocusDemand(w.key(), "limited", null, since, null));
                if (!focusLeased.contains(w.key()))
                    yield new WsMessages.DemandMsg("demand", null, new WsMessages.FocusDemand(w.key(), "throttled", null, since, null));
                CollectorDemandStatus cs = st.get("focus:" + w.key());
                String state = stateOf(cs, nowMs, Set.of("throttled", "not_found", "error", "disabled"));
                boolean known = !"pending".equals(state);
                yield new WsMessages.DemandMsg("demand", null, new WsMessages.FocusDemand(w.key(), state,
                        known ? cs.intervalS() : null, since, cs == null ? null : cs.lastSuccessAt()));
            }
            case FOCUS_CAPPED -> new WsMessages.DemandMsg("demand", null,
                    new WsMessages.FocusDemand(w.key(), "expired_session_cap", null, Instant.ofEpochMilli(w.sinceMs()), null));
        };
    }

    private static String stateOf(CollectorDemandStatus cs, long nowMs, Set<String> passThrough) {
        if (cs == null) return "pending";
        if (cs.activeAt(nowMs)) return "active";
        return passThrough.contains(cs.state()) ? cs.state() : "pending";
    }

    private void warn(String msg, RuntimeException e) {
        long now = System.currentTimeMillis();
        if (now - lastWarnMs > 60_000) {
            lastWarnMs = now;
            log.warn(msg, e.toString());
        } else {
            log.debug(msg, e.toString());
        }
    }
}
