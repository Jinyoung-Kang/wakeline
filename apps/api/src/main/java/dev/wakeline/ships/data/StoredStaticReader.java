package dev.wakeline.ships.data;

import dev.wakeline.ships.core.ShipStatic;
import dev.wakeline.platform.data.ReadPool;
import dev.wakeline.platform.support.SingleFlight;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.function.LongSupplier;

/**
 * 저장된 AIS 정적 보고 읽기(static-fallback · 계약 v5 §G17) — 선택 선박(WS ship_selected)의 정적 정보가 api 메모리(ShipStore)에 없을 때만 부른다.
 * <ul>
 *   <li>왜: 메모리의 정적 정보는 선박 스트림(보존 약 2.5 h)에서만 다시 채워진다. api 가 다시 시작한 뒤, 그보다 오래 전에 정적 보고를 보낸 선박은
 *       스트림에 다시 올 때까지 정적 정보가 없다(입출항도 호출부호를 몰라 no_call_sign). DB ship 표에는 마지막으로 저장한 정적 보고가 있다.</li>
 *   <li>값은 DB 행 그대로({@link ShipRepository#find} — 공개 조회 상한 {@value Sql#PUBLIC_READ_TIMEOUT_S} s). 메모리(ShipStore)에 넣지 않는다 — 지도 목록 ·
 *       검색의 실시간 값과 섞지 않고, 받는 쪽이 출처를 stored 로 밝힌다.</li>
 *   <li>시각: 저장 행의 updated_at = 이 행에 마지막으로 저장한 정적 메시지의 aisstream 수신 시각(DB 에 기록된 수신 시각 — 그 메시지가 싣지 않은 필드는
 *       그보다 앞서 저장된 보고의 값이다, 계약 v5 §G19). 수집기(ShipBook)는 메모리의
 *       정적 정보가 바뀐 메시지의 시각을 싣는데, 그 메모리는 수집기가 다시 시작하면 비고 30분 넘게 수신이 없거나 선박 수 상한에 밀린 선박을 지운다 —
 *       그 뒤 같은 내용을 다시 받으면 새 시각이 실려 행을 덮는다. 그 밖의 같은 내용 재수신(수집기가 30분마다 다시 보낸다)은 저장하지 않는다(ShipWriter).
 *       그래서 이 값은 지금 내용의 첫 수신도 마지막 수신도 아니고, 그렇게 말하지 않는다(ship.last_seen 은 위치 보고로도 넓혀진다).</li>
 *   <li>메모리 캐시(MMSI 별): 찾음 · 없음은 {@value #TTL_MS} ms, 읽기 실패(시간 초과 · 연결 없음 · 그 밖의 예외)는 {@value #ERROR_TTL_MS} ms — 선택 하나를
 *       되풀이해 다시 계산해도(선박 변화 · {@code ShipFanout} 주기 다시 보기) DB 는 MMSI 마다 이 간격에 한 번. 실패는 예외가 아니라 {@link Status#UNAVAILABLE}.
 *       같은 MMSI 의 동시 miss(그 선박을 고른 세션들 · 한 세션의 되풀이 물음)는 한 번만 읽고 결과를 함께 쓴다({@link SingleFlight} — 기다리는 쪽은
 *       future 에 이어 붙어 스레드를 잡지 않는다. 리뷰: 공유 풀 · 조회 스레드를 세션 수만큼 쓰지 않게).</li>
 *   <li>부르는 쪽(계약 v5 §G18 · ADR-025): {@link #cached} 는 세션 우편함(WsSession SerialOutbox)에서 — 메모리만 본다. {@link #lookupAsync} 는 DB 를
 *       우편함 밖 선택 조회 실행기(ShipFanout · ShipLookups)에서 읽는다 — 기다리는 동안에도 그 세션의 diff · pong 은 간다. {@link #lookup} 은 같은 읽기를
 *       부른 스레드에서(시험 · 도구). DB 는 선택 조회 전용 풀({@link ReadPool} — 연결 대기 ≤ 문장 상한)로 읽는다: 한 번의 읽기 최악 =
 *       {@link ReadPool#readBoundMs()}(서버가 답할 때 — 기본 2 s + 3 s), 서버가 멈추면 {@link ReadPool#hardReadBoundMs()}(2 s + 소켓 5 s).</li>
 *   <li>로그에는 MMSI · 오류 종류만.</li>
 * </ul>
 */
@Component
public class StoredStaticReader {
    private static final Logger log = LoggerFactory.getLogger(StoredStaticReader.class);
    public static final long TTL_MS = 60_000;
    public static final long ERROR_TTL_MS = 15_000;
    /** 캐시 항목 상한 — 넘으면 만료된 것을 치우고, 그래도 넘으면 비운다. */
    static final int MAX_ENTRIES = 4_096;

    /** STORED: 저장된 정적 보고가 있다 · NONE: 행이 없거나 정적 보고를 받은 적 없는 행(위치로만 만든 행) · UNAVAILABLE: DB 를 읽지 못했다(있는지 모름). */
    public enum Status { STORED, NONE, UNAVAILABLE }

    /** 읽은 결과. STORED 일 때만 stat 이 있다(그 행의 updated_at = stat.updatedAt()). */
    public record Lookup(Status status, ShipStatic stat) {
        public static final Lookup NONE = new Lookup(Status.NONE, null);
        public static final Lookup UNAVAILABLE = new Lookup(Status.UNAVAILABLE, null);

        public static Lookup stored(ShipStatic stat) { return new Lookup(Status.STORED, stat); }
    }

    /** MMSI → 저장된 정적 보고(없으면 null). 실패는 예외. 운영: ShipRepository.find — 시험은 가짜. */
    @FunctionalInterface
    public interface Source {
        ShipStatic find(String mmsi);
    }

    private record Memo(Lookup value, long atMs) {}

    private final Source source;
    private final LongSupplier clock;
    private final ConcurrentHashMap<String, Memo> cache = new ConcurrentHashMap<>();
    /** MMSI → 진행 중인 읽기. 같은 MMSI 의 동시 miss 는 이것에 이어 붙는다(DB 를 한 번만 읽는다). */
    private final SingleFlight<String, Lookup> inflight = new SingleFlight<>();
    private final Counter hit;
    private final Counter miss;
    private final Counter errors;

    /** 운영: 선택 조회 전용 풀({@link ReadPool})로 ship 행을 읽는다({@link ShipRepository#find(JdbcClient, String)} — REST 와 같은 문장 · 행 해석). */
    @Autowired
    public StoredStaticReader(ReadPool pool, MeterRegistry meters) {
        this(statOf(mmsi -> ShipRepository.find(pool.jdbc(), mmsi)), System::currentTimeMillis, meters);
    }

    /** 시험용: 저장소(가짜 가능)의 find 로 읽는다. */
    public StoredStaticReader(ShipRepository repo, MeterRegistry meters) {
        this(statOf(repo::find), System::currentTimeMillis, meters);
    }

    private static Source statOf(java.util.function.Function<String, ShipRepository.StoredShip> find) {
        return mmsi -> {
            ShipRepository.StoredShip s = find.apply(mmsi);
            return s == null ? null : s.stat();
        };
    }

    /** 시험용(다른 패키지의 WS 시험도 쓴다): 읽기 · 시계를 주입한다. */
    public StoredStaticReader(Source source, LongSupplier clock, MeterRegistry meters) {
        this.source = source;
        this.clock = clock;
        this.hit = Counter.builder("wakeline_cache_requests_total").tag("cache", "stored_static").tag("result", "hit").register(meters);
        this.miss = Counter.builder("wakeline_cache_requests_total").tag("cache", "stored_static").tag("result", "miss").register(meters);
        this.errors = Counter.builder("wakeline_stored_static_errors_total")
                .description("선택 선박의 저장된 AIS 정적 보고(DB ship)를 읽지 못한 수 — ship_selected.static_source = stored_unavailable").register(meters);
    }

    /**
     * 캐시에만 묻는다(DB 를 읽지 않는다 — 우편함에서 불러도 된다): 신선한 값이면 그것(지표 hit), 아니면 null — 부르는 쪽이 {@link #lookup} 을 우편함 밖에서 부른다.
     */
    public Lookup cached(String mmsi) {
        Memo m = cache.get(mmsi);
        if (!fresh(m, clock.getAsLong())) return null;
        hit.increment();
        return m.value();
    }

    /**
     * 이 MMSI 의 저장된 정적 보고(캐시 — 찾음 · 없음 {@value #TTL_MS} ms, 실패 {@value #ERROR_TTL_MS} ms)를 executor 에서 읽는다. 신선한 캐시면 곧바로
     * 끝난 future. 같은 MMSI 를 이미 읽는 중이면 그 읽기의 future(스레드를 잡지 않는다). 지표 hit = DB 를 읽지 않았다(캐시 또는 진행 중인 읽기), miss = DB 읽기.
     * DB 오류는 {@link Status#UNAVAILABLE} 값으로 끝난다. future 가 예외로 끝나는 것은 실행기가 거절했을 때(RejectedExecutionException — 기억하지 않는다)와
     * 읽기의 결함(Error)뿐 — 부르는 쪽이 '읽지 못함' 으로 말한다.
     */
    public CompletableFuture<Lookup> lookupAsync(String mmsi, Executor executor) {
        Memo m = cache.get(mmsi);
        if (fresh(m, clock.getAsLong())) {
            hit.increment();
            return CompletableFuture.completedFuture(m.value());
        }
        SingleFlight.Flight<Lookup> f = inflight.run(mmsi, () -> readThrough(mmsi), executor);
        if (f.joined()) hit.increment();
        return f.result();
    }

    /**
     * {@link #lookupAsync} 를 부른 스레드에서(시험 · 도구 — 운영의 선택 조회는 우편함 밖 실행기에서 lookupAsync). 같은 MMSI 를 다른 스레드가 읽는 중이면 그 결과를
     * 기다린다. 예외를 던지지 않는다(그 읽기가 결함으로 끝났으면 기다린 쪽은 모름 — UNAVAILABLE).
     */
    public Lookup lookup(String mmsi) {
        try {
            return lookupAsync(mmsi, Runnable::run).join();
        } catch (CompletionException e) {
            return Lookup.UNAVAILABLE;
        }
    }

    /** 진행 중 표시를 얻은 쪽만: 그사이 다른 읽기가 캐시를 채웠으면 그것, 아니면 DB 를 읽어 캐시에 넣는다. */
    private Lookup readThrough(String mmsi) {
        long now = clock.getAsLong();
        Memo m = cache.get(mmsi);
        if (fresh(m, now)) {
            hit.increment();
            return m.value();
        }
        miss.increment();
        Lookup v = read(mmsi);
        // 다시 읽어도 같은 값이면 같은 객체 — 받는 쪽(ShipFanout)이 바뀌지 않은 ship_selected 를 다시 보내지 않게
        if (m != null && v.equals(m.value())) v = m.value();
        if (cache.size() >= MAX_ENTRIES) prune(now);
        cache.put(mmsi, new Memo(v, now));
        return v;
    }

    private Lookup read(String mmsi) {
        try {
            ShipStatic st = source.find(mmsi);
            // 정적 보고를 받은 적 없는 행(updated_at NULL — ShipRepository 는 이미 null 로 준다)은 저장된 보고가 아니다
            return st == null || st.updatedAt() == null ? Lookup.NONE : Lookup.stored(st);
        } catch (RuntimeException e) {
            errors.increment();
            log.debug("stored ship static unavailable for {}: {}", mmsi, e.getClass().getSimpleName());
            return Lookup.UNAVAILABLE;
        }
    }

    private static boolean fresh(Memo m, long now) {
        if (m == null || now < m.atMs()) return false;
        return now - m.atMs() < (m.value().status() == Status.UNAVAILABLE ? ERROR_TTL_MS : TTL_MS);
    }

    private void prune(long now) {
        cache.values().removeIf(e -> !fresh(e, now));
        if (cache.size() >= MAX_ENTRIES) cache.clear();
    }

    int cached() { return cache.size(); }

    int inflight() { return inflight.size(); }
}
