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
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * 선박 저장(ADR-014 · 계약 v2 §B3): 위치(ship_position) · 정적 정보(ship) · 수신 공백(ingest_gap). 스트림 소비 스레드는 거르고 큐에 넣기만 하고
 * DB 는 이 가상 스레드 하나만 쓴다(소비·WS 가 DB 를 기다리지 않는다).
 * <ul>
 *   <li>줄이기: MMSI 별 60 s 창(에포크 정렬)마다 첫 보고 하나만 쓴다 — 메모리 필터(여기, 소비 스레드) + DB 가드(ShipRepository — 재시작 뒤에도
 *       창마다 하나). 걸러 낸 보고는 wakeline_ship_rows_total{result=downsampled}. ship.last_seen 은 위치로는 10분에 한 번만 넓힌다(쓰기 증폭 방지).</li>
 *   <li>정적 정보: updated_at 이 이미 쓴 것보다 새 것만(수집기는 같은 내용을 30분마다 다시 보낸다 — 같은 것은 다시 쓰지 않는다. 행을 버리면 그 기억을
 *       비워 다음 재전송을 다시 쓴다). 있는 행은 받은 필드만
 *       덮는다(계약 v5 §G19 — ShipRepository.STATIC_SQL). 받은 필드를 싣지 않은 정적 정보(이전 수집기 — 배포 전환 중)는 값이 있는 필드만 덮고
 *       wakeline_ship_static_unknown_fields_total 로 센다.</li>
 *   <li>큐 상한 100,000 행 — 넘치면 오래된 것부터 버리고 result=dropped 로 센다. 실패는 TrackWriter 와 같다: 일시 장애는 같은 배치를 백오프(2 s → 30 s)로
 *       재시도, 영구 오류(SQLState 21·22·23·42)는 3회 뒤 버리고 result=failed — 배치 하나가 저장기를 멈추지 못한다.</li>
 *   <li>at-least-once(API-CONC-8): 메시지의 행이 모두 커밋(또는 버림)된 뒤 영수증을 놓는다 → XACK. 공백은 순서 큐(OrderedWriter)가 같은 규칙으로.</li>
 *   <li>종료: 스트림 소비·WS 뒤(phase) 워커가 진행 중 배치를 끝내고 <b>스스로</b> 남은 행을 쓴다(DB 를 쓰는 스레드는 종료 때도 하나 — 조사 2026-10-01
 *       종료 F3: 예전에는 stop 이 2 s 기다린 뒤 다른 스레드가 flush 해, 느린 쓰기와 같은 배치를 동시에 쓰고 쓰지 못한 배치의 영수증을 놓을 수 있었다).
 *       stop 요청 뒤 8 s 가 지나면 새 배치를 쓰기 시작하지 않고, stop 은 최대 9 s 기다린다(lifecycle 단계 한도 10 s 안). 못 쓴 행의 메시지는 ACK 하지
 *       않는다(다음 기동에서 다시 처리 — 쓰기는 멱등). stop 요청 뒤 실패한 쓰기는 기다리지 않고 종료 flush 가 한 번 더 쓴다. 워커가 오류(Error)로
 *       죽었으면 ERROR 한 줄을 남기고, 남은 행은 stop 이 쓴다(그때 쓰는 스레드는 stop 하나).</li>
 *   <li>고른 위치(60 s 창의 첫 보고)를 {@link IngestEvents.ShipsSampled} 로 알린다(소비 스레드, 동기 — 파이프라인 이벤트라 리스너 예외는 그 리스너에 갇힌다,
 *       API-CONC-2) — 관측 수신 격자(ADR-027 · coverage.ShipCoverage)가 DB 의 ship_position 과 같은 표본을 센다(부트스트랩이 읽는 행과 실시간 셈이 같은 뜻).</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class ShipWriter implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(ShipWriter.class);
    static final int QUEUE_MAX = 100_000;
    static final int BATCH = 2_000;
    /**
     * 풀리지 않은 표식(= ACK 를 기다리는 선박 메시지) 상한. 넘으면 가장 오래된 것부터 놓는다(wakeline_ship_receipts_forced_total) — DB 가 오래 죽어
     * 있을 때 표식과 PEL 이 끝없이 늘지 않게. 상한으로 놓는 것이 이미 스트림에서 지워진 메시지뿐이도록 보존 창에 들 수 있는 메시지 수 이상으로 잡는다:
     * wakeline:ships 는 시간으로 자른다(MINID ~ 지금 − 2.5 h = 9,000 s, collector publisher.py STREAM_RETENTION_S — 바이트 예산은 창을 줄일 뿐이다).
     * ais 는 ais_flush_s(기본 10 s, 설정 하한 1 s — ais/config.py)마다 XADD 한 번(바뀐 선박 · 정적 정보가 CHUNK 5,000 건을 넘을 때만 나눈다 —
     * 장애 뒤 몰린 한 번은 그동안 못 보낸 flush 들을 대신한다. 실패한 XADD 는 다음 flush 에 다시 싣고 따로 쌓아 재전송하지 않는다) →
     * 9,000 s 에 기본 900개, 하한에서 ≤ 9,002개(창 양 끝 · 종료 때의 마지막 flush 포함). 그래서 10,000(조사 2026-10-01: 예전 1,000 은
     * 'MAXLEN ~200 보다 훨씬 크다' 가 근거였다 — 시간 트리밍 뒤로는 기본 주기에서 여유가 약 11 % 였고, 주기를 9 s 아래로 줄이면 스트림에 아직 있는
     * 메시지를 놓았다). DB 장애가 길면 대개 큐 상한(QUEUE_MAX 행)이 먼저 걸린다 — 행이 모두 넘쳐 버려진 메시지는 그때 놓인다(result=dropped 로
     * 센다). 이 계산은 tools/contract_check.py(receipt_mark_bounds)가 수집기 상수로 다시 한다 — 상수가 바뀌어 상한을 넘으면 그 검사가 실패한다.
     */
    static final int MAX_MARKS = 10_000;
    static final int PERMANENT_ATTEMPTS = 3;
    static final long BACKOFF_START_MS = 2_000;
    static final long BACKOFF_MAX_MS = 30_000;
    /** stop() 이 워커(진행 중 쓰기 + 마지막 flush)를 기다리는 상한 — lifecycle 단계 한도 10 s(application.yml timeout-per-shutdown-phase) 안. */
    static final long STOP_WAIT_MS = 9_000;
    /** 마지막 flush 는 stop 요청 뒤 (기다림 상한 − 이 값)이 지나면 새 배치를 쓰기 시작하지 않는다 — 마지막으로 시작한 배치가 커밋될 여유. */
    static final long LAST_BATCH_MARGIN_MS = 1_000;
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
    /**
     * 큐의 행을 쓰지 못하고 버렸다(넘침 · 영구 실패) — 다음 {@link #select} 가 정적 정보 기억을 비운다(리뷰 cto-2026-10 D1). 기억은 '큐에 넣음' 을 적으므로
     * 버린 정적 정보를 그대로 두면 수집기의 30분 재전송(같은 updated_at)을 '이미 씀' 으로 건너뛰어 다시 띄울 때까지 ship 행이 비거나 낡았다.
     * 비운 뒤에는 정적 정보마다 한 번씩 다시 쓴다(upsert · updated_at 가드라 멱등). 기억 자체는 소비 스레드만 만진다.
     */
    private volatile boolean forgetStatics;
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
    /** 고른 위치의 알림(운영: 애플리케이션 이벤트 — {@link IngestEvents.ShipsSampled}). */
    private final Consumer<Object> publish;
    /** stop() 의 기다림 상한(테스트가 줄인다). */
    long stopWaitMs = STOP_WAIT_MS;
    private volatile boolean running;
    /** stop 을 요청한 시각(epoch ms, 없으면 0) — 마지막 flush 의 마감 기준. */
    private volatile long stopRequestedAtMs;
    private Thread worker;
    /** 실패해서 다시 쓸 배치. 워커 스레드에서만(종료 flush 도 워커가 한다). */
    private volatile ReceiptBatchQueue.Batch<Item> pending;

    @org.springframework.beans.factory.annotation.Autowired
    public ShipWriter(ShipRepository repo, OrderedWriter ordered, MeterRegistry meters, ApplicationEventPublisher events) {
        this(repo, ordered, meters, BACKOFF_START_MS, BACKOFF_MAX_MS, events::publishEvent);
    }

    /** 테스트용: 재시도 간격을 줄인다(고른 위치는 알리지 않는다). */
    ShipWriter(ShipRepository repo, OrderedWriter ordered, MeterRegistry meters, long backoffStartMs, long backoffMaxMs) {
        this(repo, ordered, meters, backoffStartMs, backoffMaxMs, e -> {});
    }

    /** 테스트용: 고른 위치의 알림을 받는다. */
    ShipWriter(ShipRepository repo, OrderedWriter ordered, MeterRegistry meters, long backoffStartMs, long backoffMaxMs, Consumer<Object> publish) {
        this.publish = publish;
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
        List<Item> items = select(e.states(), e.statics(), e.fetchedAt());
        List<ShipState> kept = new ArrayList<>(items.size());
        for (Item it : items) if (it instanceof Pos p) kept.add(p.state());
        // 알린 뒤에 큐에 넣는다: 그래서 알림을 받은 쪽(관측 수신 격자)이 본 행은 그 알림 뒤에 저장된다 — 부트스트랩이 이미 읽은 시의 늦은 보고를 두 번 세지
        // 않고 실시간으로 셀 수 있다(ShipCoverage.onSampled — 리뷰 2026-09-30 밤)
        if (!kept.isEmpty()) publish.accept(new IngestEvents.ShipsSampled(List.copyOf(kept)));
        enqueue(items, e.receipt());
    }

    /** 큐에 넣은 마지막 행 번호(관측 수신 격자가 밀린 행이 저장되기를 기다릴 때 — ShipCoverage.backlogWritten). */
    public long enqueuedSeq() { return queue.lastAddedSeq(); }

    /** 이 번호까지의 행은 끝났다(쓰기 커밋 · 영구 실패 · 넘쳐 버림 — 번호 순서로 끝난다). */
    public long settledSeq() { return queue.settledUpTo(); }

    /** 공백은 드물고 순서가 중요하지 않지만 재시도·영수증 규칙이 같은 순서 큐로 보낸다. */
    @EventListener
    public void onGap(IngestEvents.AisGapReceived e) {
        ordered.submit(OrderedWriter.task("ais_gap", () -> repo.insertGap(e.gap()), e.receipt().hold()));
    }

    /** 소비 스레드: 저장할 행을 고른다(60 s 창마다 첫 보고 · 새 정적 정보). */
    List<Item> select(List<ShipState> states, List<ShipStatic> statics, Instant receivedAt) {
        if (forgetStatics) {
            forgetStatics = false;
            staticSeen.clear();
        }
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
            forgetStatics = true;
            dropped.increment(items.size());
            return;
        }
        ReceiptBatchQueue.Added a = queue.add(items, receipt);
        if (a.dropped() > 0) {
            forgetStatics = true; // 넘쳐 버린 행에 정적 정보가 있었을 수 있다
            dropped.increment(a.dropped());
        }
        if (a.forced() > 0) forced.increment(a.forced());
    }

    @Override
    public void start() {
        stopRequestedAtMs = 0;
        running = true;
        worker = Thread.ofVirtual().name("ship-writer").start(this::run);
    }

    /** 워커: 쓰기 루프 → 종료 flush. DB 를 쓰는 스레드는 이것 하나다(ShipRepository.POSITION_SQL 의 창 가드가 기대는 것). */
    private void run() {
        try {
            loop();
            flush();
        } catch (Error err) {
            // 예외가 아닌 오류(OOM · StackOverflowError 등)로 끝났다 — 조용히 죽지 않는다. 그 뒤 쌓이는 행은 stop 이 쓴다(쓰는 스레드가 그때는 stop 하나)
            log.error("ship writer thread died ({}) — nothing writes ship rows until shutdown; stop() then writes what is queued", err.toString(), err);
        }
    }

    /**
     * 워커가 진행 중 배치와 마지막 flush 를 끝내기를 최대 {@link #stopWaitMs} 기다린다 — 이 스레드는 쓰지 않는다. 그 안에 끝나지 않으면(쓰기 하나가
     * DB 에서 돌아오지 않음) 그렇다고 남기고 돌아간다: 워커는 마감 뒤 새 배치를 쓰기 시작하지 않고, 쓰지 않은 행의 메시지는 ACK 되지 않는다.
     */
    @Override
    public void stop() {
        requestStop();
        Thread w = worker;
        if (w == null) { // 시작한 적 없다 — 같이 쓰는 스레드가 없다
            flush();
            return;
        }
        try { w.join(stopWaitMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (w.isAlive()) {
            log.warn("ship writer still busy {} ms after stop (a DB write has not returned) — shutdown continues; the writer starts no new batch and logs"
                    + " its own result, and rows it has not written keep their stream messages unacknowledged (re-processed on restart)", stopWaitMs);
            return;
        }
        // 워커는 끝났다 — 보통은 스스로 flush 했으므로 남은 것이 없다(빈 flush 는 아무것도 남기지 않는다). 오류로 죽었다면(run) 남은 행을 여기서 쓴다:
        // 쓰는 스레드는 이제 이것 하나다(리뷰 2026-10-01 — 예전에는 죽은 워커 뒤로 flush · WARN · dropped 가 없었다)
        flush();
    }

    private void requestStop() {
        if (stopRequestedAtMs == 0) stopRequestedAtMs = System.currentTimeMillis();
        running = false;
    }

    @Override
    public void stop(Runnable callback) {
        requestStop();
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
                if (!running) {
                    // stop 이 이미 요청됐다 — 기다려 다시 시도하지 않는다: 루프를 나가 곧바로 종료 flush 가 이 배치부터 쓴다(마감 안이면). 'retry in …' 은
                    // 일어나지 않는 기다림이었다(리뷰 2026-10-01 — 2026-09-30 17:58:51 호스트 종료 로그)
                    log.warn("ship batch ({} rows) failed while stopping — the shutdown flush tries it once more before its deadline (queue {}): {}",
                            n, queue.size(), e.toString());
                    continue;
                }
                if (!TrackWriter.isPermanent(e)) {
                    log.warn("ship batch ({} rows) failed, retry in {} ms (queue {}): {}", n, backoff, queue.size(), e.toString());
                } else if (++permanentFailures >= PERMANENT_ATTEMPTS) {
                    if (pending != null && pending.items().stream().anyMatch(it -> it instanceof Stat)) forgetStatics = true;
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

    /**
     * 종료 시(워커 — 시작한 적 없으면 stop 을 부른 스레드): 재시도 중이던 배치 + 큐를 마감(stop 요청 + 기다림 상한 − 여유) 안에서 순서대로 쓴다.
     * 앞에서부터 이어서 쓴 행까지만 영수증을 놓는다.
     */
    void flush() {
        List<ReceiptBatchQueue.Batch<Item>> rest = new ArrayList<>();
        ReceiptBatchQueue.Batch<Item> p = pending;
        pending = null;
        if (p != null) rest.add(p);
        ReceiptBatchQueue.Batch<Item> b;
        while ((b = queue.poll()) != null) rest.add(b);
        long stopAt = stopRequestedAtMs;
        long deadline = (stopAt > 0 ? stopAt : System.currentTimeMillis()) + stopWaitMs - LAST_BATCH_MARGIN_MS;
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
