package dev.wakeline.persist;

import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.Receipt;
import dev.wakeline.ingest.ShipStore;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 선박 저장(ADR-014 · 계약 v2 §B3): 위치(ship_position) · 정적 정보(ship) · 수신 공백(ingest_gap). 스트림 소비 스레드는 거르고 큐에 넣기만 하고
 * DB 는 이 가상 스레드 하나만 쓴다(소비·WS 가 DB 를 기다리지 않는다).
 * <ul>
 *   <li>줄이기: MMSI 별 60 s 창(에포크 정렬)마다 첫 보고 하나만 쓴다 — 메모리 필터(여기, 소비 스레드) + DB 가드(ShipRepository — 재시작 뒤에도
 *       창마다 하나). 걸러 낸 보고는 wakeline_ship_rows_total{result=downsampled}. ship.last_seen 은 위치로는 10분에 한 번만 넓힌다(쓰기 증폭 방지).</li>
 *   <li>정적 정보: updated_at 이 이미 쓴 것보다 새 것만(수집기는 같은 내용을 30분마다 다시 보낸다 — 같은 것은 다시 쓰지 않는다). 있는 행은 받은 필드만
 *       덮는다(계약 v5 §G19 — ShipRepository.STATIC_SQL). 받은 필드를 싣지 않은 정적 정보(이전 수집기 — 배포 전환 중)는 값이 있는 필드만 덮고
 *       wakeline_ship_static_unknown_fields_total 로 센다.</li>
 *   <li>큐 상한 100,000 행 — 넘치면 오래된 것부터 버리고 result=dropped 로 센다. 실패는 TrackWriter 와 같다: 일시 장애는 같은 배치를 백오프(2 s → 30 s)로
 *       재시도, 영구 오류(SQLState 21·22·23·42)는 3회 뒤 버리고 result=failed — 배치 하나가 저장기를 멈추지 못한다.</li>
 *   <li>at-least-once(API-CONC-8): 메시지의 행이 모두 커밋(또는 버림)된 뒤 영수증을 놓는다 → XACK. 공백은 순서 큐(OrderedWriter)가 같은 규칙으로.</li>
 *   <li>종료: 스트림 소비·WS 뒤(phase) 남은 행을 최대 6 s 동안 쓰고, 못 쓴 행의 메시지는 ACK 하지 않는다(다음 기동에서 다시 처리 — 쓰기는 멱등).</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class ShipWriter implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(ShipWriter.class);
    static final int QUEUE_MAX = 100_000;
    static final int BATCH = 2_000;
    /** 풀리지 않은 표식 상한 — 스트림 보존(MAXLEN ~200)보다 훨씬 크다. 넘으면 가장 오래된 것부터 놓는다(wakeline_ship_receipts_forced_total). */
    static final int MAX_MARKS = 1_000;
    static final int PERMANENT_ATTEMPTS = 3;
    static final long BACKOFF_START_MS = 2_000;
    static final long BACKOFF_MAX_MS = 30_000;
    static final long FLUSH_DEADLINE_MS = 6_000;
    /** ship.last_seen 을 위치로 넓히는 단위(분). */
    static final long TOUCH_WINDOW_MIN = 10;
    /**
     * 저장하는 보고 시각의 범위(지금 − 24 h ~ 지금 + 5분). 파티션은 어제부터 있으므로 그 밖의 행은 파티션이 없어 배치 전체를 영구 오류로
     * 만든다 — 한 건 때문에 멀쩡한 행 2,000개를 잃지 않게 미리 걸러 result=out_of_range 로 센다(수집기 품질 게이트가 먼저 거르는 값이다).
     */
    static final long KEEP_PAST_S = 24 * 3600;
    static final long KEEP_FUTURE_S = 5 * 60;
    /** 줄이기·정적 정보 기억 상한(가장 오래 안 쓴 것부터 잊는다 — 잊어도 DB 가드가 창마다 하나를 지킨다). */
    static final int MEMORY_MAX = 2 * ShipStore.MAX_SHIPS;

    /** 큐의 한 행: 위치(touch = 이 행으로 ship.last_seen 을 넓힌다) 또는 정적 정보. */
    sealed interface Item permits Pos, Stat {}

    record Pos(ShipState state, boolean touch) implements Item {}

    record Stat(ShipStatic stat, Instant receivedAt) implements Item {}

    private final ShipRepository repo;
    private final OrderedWriter ordered;
    private final ReceiptBatchQueue<Item> queue = new ReceiptBatchQueue<>(QUEUE_MAX, MAX_MARKS, BATCH);
    // ---- 소비 스레드 전용(이벤트 리스너) ----
    /** MMSI → {마지막으로 받아들인 60 s 창, 마지막으로 last_seen 을 넓힌 10분 창}. */
    private final Map<String, long[]> kept = lru(MEMORY_MAX);
    /** MMSI → 마지막으로 큐에 넣은 정적 정보의 updated_at. */
    private final Map<String, Instant> staticSeen = lru(MEMORY_MAX);
    // ----
    private final Counter written;
    private final Counter staticWritten;
    private final Counter staticUnknownFields;
    private final Counter dropped;
    private final Counter failed;
    private final Counter downsampled;
    private final Counter outOfRange;
    private final Counter forced;
    private final long backoffStartMs;
    private final long backoffMaxMs;
    private volatile boolean running;
    private Thread worker;
    /** 실패해서 다시 쓸 배치. 워커 스레드에서만(종료 flush 는 워커가 멈춘 뒤). */
    private volatile ReceiptBatchQueue.Batch<Item> pending;

    @org.springframework.beans.factory.annotation.Autowired
    public ShipWriter(ShipRepository repo, OrderedWriter ordered, MeterRegistry meters) {
        this(repo, ordered, meters, BACKOFF_START_MS, BACKOFF_MAX_MS);
    }

    /** 테스트용: 재시도 간격을 줄인다. */
    ShipWriter(ShipRepository repo, OrderedWriter ordered, MeterRegistry meters, long backoffStartMs, long backoffMaxMs) {
        this.repo = repo;
        this.ordered = ordered;
        this.backoffStartMs = backoffStartMs;
        this.backoffMaxMs = backoffMaxMs;
        meters.gauge("wakeline_ship_queue", queue, ReceiptBatchQueue::size);
        written = Counter.builder("wakeline_ship_rows_total").tag("result", "written").description("쓴 위치 행(60 s 창 가드로 DB 가 건너뛴 것 포함)").register(meters);
        staticWritten = Counter.builder("wakeline_ship_static_rows_total").description("쓴 정적 정보 행").register(meters);
        staticUnknownFields = Counter.builder("wakeline_ship_static_unknown_fields_total")
                .description("받은 필드를 싣지 않은 정적 정보(이전 수집기 — 값이 있는 필드만 덮는다, 계약 v5 §G19)").register(meters);
        dropped = Counter.builder("wakeline_ship_rows_total").tag("result", "dropped").description("큐가 넘치거나 종료로 쓰지 못한 행").register(meters);
        failed = Counter.builder("wakeline_ship_rows_total").tag("result", "failed").description("영구 오류로 버린 행").register(meters);
        downsampled = Counter.builder("wakeline_ship_rows_total").tag("result", "downsampled").description("60 s 창의 첫 보고가 아니어서 쓰지 않은 보고").register(meters);
        outOfRange = Counter.builder("wakeline_ship_rows_total").tag("result", "out_of_range")
                .description("보고 시각이 저장 범위(지금 − 24 h ~ + 5분) 밖이라 쓰지 않은 보고").register(meters);
        forced = Counter.builder("wakeline_ship_receipts_forced_total")
                .description("행이 durable 해지기 전에 상한 때문에 놓은 메시지 영수증(스트림 보존보다 오래된 것)").register(meters);
    }

    private static <V> Map<String, V> lru(int max) {
        return new LinkedHashMap<>(1024, 0.75f, true) {
            @Override protected boolean removeEldestEntry(Map.Entry<String, V> e) { return size() > max; }
        };
    }

    @EventListener
    public void onShips(IngestEvents.ShipsUpdated e) {
        if (e.states().isEmpty() && e.statics().isEmpty()) return; // 만료·부트스트랩 — 저장할 보고 없음
        enqueue(select(e.states(), e.statics(), e.fetchedAt()), e.receipt());
    }

    /** 공백은 드물고 순서가 중요하지 않지만 재시도·영수증 규칙이 같은 순서 큐로 보낸다. */
    @EventListener
    public void onGap(IngestEvents.AisGapReceived e) {
        ordered.submit(OrderedWriter.task("ais_gap", () -> repo.insertGap(e.gap()), e.receipt().hold()));
    }

    /** 소비 스레드: 저장할 행을 고른다(60 s 창마다 첫 보고 · 새 정적 정보). */
    List<Item> select(List<ShipState> states, List<ShipStatic> statics, Instant receivedAt) {
        List<Item> out = new ArrayList<>(statics.size() + states.size());
        for (ShipStatic st : statics) {
            Instant prev = staticSeen.get(st.mmsi());
            if (prev != null && !st.updatedAt().isAfter(prev)) continue; // 같은 내용의 재전송 또는 더 오래된 것
            staticSeen.put(st.mmsi(), st.updatedAt());
            if (st.received() == null) staticUnknownFields.increment();
            out.add(new Stat(st, receivedAt == null ? st.updatedAt() : receivedAt));
        }
        int skipped = 0, range = 0;
        long nowS = System.currentTimeMillis() / 1000;
        for (ShipState s : states) {
            long t = s.seenAt().getEpochSecond();
            if (t < nowS - KEEP_PAST_S || t > nowS + KEEP_FUTURE_S) { range++; continue; }
            long window = Math.floorDiv(t, ShipRepository.WINDOW_S);
            long touchWindow = Math.floorDiv(window, TOUCH_WINDOW_MIN);
            long[] k = kept.get(s.mmsi());
            if (k != null && window <= k[0]) { skipped++; continue; } // 이 창(또는 더 이전)은 이미 첫 보고를 골랐다
            boolean touch = k == null || touchWindow != k[1];
            if (k == null) kept.put(s.mmsi(), new long[]{window, touchWindow});
            else {
                k[0] = window;
                if (touch) k[1] = touchWindow;
            }
            out.add(new Pos(s, touch));
        }
        if (skipped > 0) downsampled.increment(skipped);
        if (range > 0) outOfRange.increment(range);
        return out;
    }

    /** 큐에 넣는다(기다리지 않는다). 종료 뒤에 온 행은 쓸 스레드가 없다 — dropped 로 센다(영수증은 잡지 않는다). */
    void enqueue(List<Item> items, Receipt receipt) {
        if (items.isEmpty()) return;
        if (!running) {
            dropped.increment(items.size());
            return;
        }
        ReceiptBatchQueue.Added a = queue.add(items, receipt);
        if (a.dropped() > 0) dropped.increment(a.dropped());
        if (a.forced() > 0) forced.increment(a.forced());
    }

    @Override public void start() { running = true; worker = Thread.ofVirtual().name("ship-writer").start(this::loop); }

    @Override
    public void stop() {
        running = false;
        if (worker != null) {
            try { worker.join(2_000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        flush();
    }

    @Override
    public void stop(Runnable callback) {
        running = false;
        Thread.ofVirtual().name("ship-writer-stop").start(() -> {
            try { stop(); } finally { callback.run(); }
        });
    }

    @Override public boolean isRunning() { return running; }

    /** 항적·순서 큐와 같은 단계(스트림 소비·WS 뒤, 마지막 ACK 앞). */
    @Override public int getPhase() { return OrderedWriter.PHASE; }

    private void loop() {
        long backoff = backoffStartMs;
        int permanentFailures = 0;
        while (running) {
            try {
                if (pending == null) pending = queue.next(1_000);
                if (pending != null) {
                    write(pending.items());
                    pending = null;
                    queue.resolved();
                    backoff = backoffStartMs;
                    permanentFailures = 0;
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return;
            } catch (RuntimeException e) {
                int n = pending == null ? 0 : pending.items().size();
                if (!TrackWriter.isPermanent(e)) {
                    log.warn("ship batch ({} rows) failed, retry in {} ms (queue {}): {}", n, backoff, queue.size(), e.toString());
                } else if (++permanentFailures >= PERMANENT_ATTEMPTS) {
                    failed.increment(n);
                    log.warn("ship batch ({} rows) failed permanently after {} attempts, dropped: {}", n, permanentFailures, e.toString());
                    pending = null;
                    queue.resolved(); // 다시 처리해도 같은 결과 — 그 메시지들은 ACK(failed 로 셌다)
                    permanentFailures = 0;
                    backoff = backoffStartMs;
                    continue;
                } else {
                    log.info("ship batch failed (attempt {}/{}), retry in {} ms: {}", permanentFailures, PERMANENT_ATTEMPTS, backoff, e.toString());
                }
                sleepWhileRunning(backoff);
                backoff = Math.min(backoffMaxMs, backoff * 2);
            }
        }
    }

    /** 한 배치: 정적 정보 → 위치(창 가드) → last_seen 넓히기. 모두 멱등이라 재시도해도 같다. */
    void write(List<Item> items) {
        List<ShipState> pos = new ArrayList<>(items.size());
        List<ShipState> touch = new ArrayList<>();
        List<ShipRepository.StaticRow> stats = new ArrayList<>();
        for (Item it : items) {
            switch (it) {
                case Pos p -> {
                    pos.add(p.state());
                    if (p.touch()) touch.add(p.state());
                }
                case Stat s -> stats.add(new ShipRepository.StaticRow(s.stat(), s.receivedAt()));
            }
        }
        repo.upsertStatics(stats);
        repo.writePositions(pos);
        repo.touch(touch);
        written.increment(pos.size());
        staticWritten.increment(stats.size());
    }

    /** 종료 시: 재시도 중이던 배치 + 큐를 마감 안에서 순서대로 쓴다. 앞에서부터 이어서 쓴 행까지만 영수증을 놓는다. */
    void flush() {
        List<ReceiptBatchQueue.Batch<Item>> rest = new ArrayList<>();
        ReceiptBatchQueue.Batch<Item> p = pending;
        pending = null;
        if (p != null) rest.add(p);
        ReceiptBatchQueue.Batch<Item> b;
        while ((b = queue.poll()) != null) rest.add(b);
        long deadline = System.currentTimeMillis() + FLUSH_DEADLINE_MS;
        int done = 0, total = 0;
        boolean contiguous = true;
        for (ReceiptBatchQueue.Batch<Item> x : rest) {
            total += x.items().size();
            if (!contiguous || System.currentTimeMillis() > deadline) { contiguous = false; continue; }
            try {
                write(x.items());
                done += x.items().size();
                queue.releaseUpTo(x.lastSeq());
            } catch (RuntimeException e) {
                contiguous = false;
                log.warn("ship flush failed: {}", e.toString());
            }
        }
        int lost = total - done;
        if (lost > 0) {
            dropped.increment(lost);
            log.warn("ship flush on shutdown: {} rows written, {} rows not written (their stream messages stay pending and are re-processed on restart)", done, lost);
        } else if (done > 0) {
            log.info("ship flush on shutdown: {} rows written", done);
        }
    }

    int queued() { return queue.size(); }

    int pendingMarks() { return queue.pendingMarks(); }

    private void sleepWhileRunning(long ms) {
        long until = System.currentTimeMillis() + ms;
        while (running && System.currentTimeMillis() < until) {
            try { Thread.sleep(Math.min(100, Math.max(1, until - System.currentTimeMillis()))); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
    }
}
