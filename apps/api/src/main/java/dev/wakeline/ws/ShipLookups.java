package dev.wakeline.ws;

import dev.wakeline.ships.core.ShipStatic;
import dev.wakeline.ships.data.StoredStaticReader;
import dev.wakeline.portcalls.PortCallReader;
import dev.wakeline.portcalls.PortCallsInfo;
import dev.wakeline.ships.web.ShipJson;
import dev.wakeline.ws.SelectionLookups.Flight;
import dev.wakeline.ws.SelectionLookups.Reads;
import dev.wakeline.ws.SelectionLookups.Source;
import io.micrometer.core.instrument.MeterRegistry;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.function.BooleanSupplier;

/**
 * 선택 선박의 DB 조회를 세션 우편함 밖에서(계약 v5 §G18 · ADR-025) — ship_selected 의 static(메모리에 없을 때 저장 정적 보고 — §G17)과 port_calls
 * (입출항 색인 — ADR-022 개정). 우편함(SerialOutbox)은 세션 상태와 전송의 주인으로 남고, DB 를 기다리는 일은 여기서 한다 — 그동안 그 세션의 항공기 ·
 * 선박 diff · pong · heartbeat 는 제때 간다.
 * <ul>
 *   <li>{@link #cached}: 읽는 쪽의 메모리 캐시만 본다(우편함에서 — I/O 없음). 다 답할 수 있으면 부르는 쪽이 곧바로 보낸다(대부분의 다시 계산 — 선박 이동 ·
 *       주기 다시 보기).</li>
 *   <li>{@link #load}: 캐시에 없는 부분을 조회 실행기에서 읽는다 — 저장 정적 보고 → 그 호출부호의 입출항 순서(입출항은 보일 정적 정보의 호출부호로 찾는다).
 *       돌려주는 {@link Flight} 는 둘로 나뉜다: answer = 답(늘 정상으로 끝나고 늦어도 마감 deadlineMs — 운영: 읽기 풀이 답하는 한 번 읽기의 상한 = 연결 대기
 *       2 s + 문장 3 s = 5 s. 그때까지 끝나지 않은 부분은 읽지 못함 — static → stored_unavailable, port_calls → error, 계약에 이미 있는 값), settled = 읽기가
 *       모두 끝남(마감과 무관 — 마감 뒤에도 읽기는 돌아 캐시를 채운다). 세션은 settled 까지 같은 물음으로 새 읽기를 올리지 않고(ShipFanout), 다음 물음의
 *       읽기는 settled 뒤에 시작한다(after) — 한 세션이 조회 실행기에 두는 작업은 늘 하나 이하다.</li>
 *   <li>같은 키의 동시 읽기는 하나(읽는 쪽의 SingleFlight — StoredStaticReader.lookupAsync 는 MMSI, PortCallReader.forStaticAsync 는 호출부호): 같은 선박을
 *       고른 세션들 · 한 세션의 되풀이 물음은 진행 중인 읽기의 future 에 이어 붙는다 — 조회 스레드를 잡지 않는다(join 으로 기다리지 않는다).</li>
 *   <li>선택이 바뀌어 쓰지 않을 조회(wanted false)는 아직 올리지 않은 읽기를 하지 않는다(outcome=skipped) — 한 세션이 선박을 연달아 바꿔도 실행기에 쌓이지 않는다.</li>
 *   <li>실행기(운영 {@link #boundedExecutor}): 스레드 = 읽기 풀 연결 수(스레드마다 연결 하나 — 이 풀 안에서 서로 연결을 기다리지 않는다), 대기열
 *       {@link #queueFor}(WS 연결 상한 이상 — 세션마다 작업 하나 이하라 연결 상한까지의 세션이 모두 읽어도 넘치지 않는다). 가득 차면 그 읽기는 하지 않고
 *       읽지 못함으로 답한다(지표 outcome=rejected — 조용히 버리지 않는다, 기억하지 않아 다음 다시 계산이 다시 올린다).</li>
 *   <li>캐시 수명(찾음 60 s · 실패 15 s · 입출항 15 s)은 읽는 쪽(StoredStaticReader · PortCallReader)이 그대로 맡는다.</li>
 *   <li>지표: wakeline_ws_ship_lookups_total{outcome=ok|deadline|rejected|error|skipped} · wakeline_ws_ship_lookup_seconds(물음 → 답) ·
 *       wakeline_ws_ship_lookup_queue(대기열 길이) · wakeline_ws_ship_lookup_dropped_total(선택 · 물음이 바뀌어 답을 보내지 않은 조회).</li>
 *   <li>마감 · 차례 · 거절 · 지표의 틀은 선택 항공기 노선 조회({@link RouteLookups})와 같은 {@link SelectionLookups} 다(계약 v5 §G21) — 이 클래스는 선박의
 *       두 읽기 사슬(저장 정적 보고 → 입출항)과 그 '읽지 못함' 값만 가진다. 실행기는 따로다(스레드 = 읽기 풀 연결 수 — Redis 노선 읽기와 나눈다).</li>
 * </ul>
 */
final class ShipLookups implements AutoCloseable {
    /** 조회 실행기 대기열의 기본 · 최소 길이(WS 연결 상한이 더 크면 그 값 — {@link #queueFor}). */
    static final int DEFAULT_QUEUE = SelectionLookups.DEFAULT_QUEUE;
    /** 조회 실행기 스레드 이름(뒤에 번호). */
    static final String THREAD_NAME = "ship-lookup-";
    /** 알 수 없는 출처(저장 정적 보고를 읽는 쪽이 없는 구성 — 시험뿐). */
    static final SelectedStatic UNKNOWN = new SelectedStatic(null, null);
    /** 메모리에 없고 DB 를 (제때) 읽지 못함 — 저장돼 있는지 모름. */
    static final SelectedStatic UNAVAILABLE = new SelectedStatic(null, ShipJson.STATIC_STORED_UNAVAILABLE);

    /** ship_selected 의 정적 정보와 그 출처(계약 v5 §G17 — {@link WsMessages#STATIC_LIVE} 등, 읽는 쪽이 없는 구성에서 모르면 null). */
    record SelectedStatic(ShipStatic stat, String source) {}

    /** 조회 결과 한 벌: 보일 정적 정보(과 출처) · 그 호출부호의 입출항(읽는 쪽이 없는 구성이면 null). */
    record Resolved(SelectedStatic sel, PortCallsInfo calls) {}

    /** 운영: 저장 정적 보고(캐시 · 같은 MMSI 한 번 읽기 — {@link StoredStaticReader}). */
    static Source<String, StoredStaticReader.Lookup> stored(StoredStaticReader r) { return Source.of(r::cached, r::lookupAsync); }

    /** 운영: 입출항 색인(호출부호별 캐시 · 같은 호출부호 한 번 읽기 — {@link PortCallReader}). */
    static Source<ShipStatic, PortCallsInfo> portCalls(PortCallReader r) { return Source.of(r::cachedForStatic, r::forStaticAsync); }

    /** 대기열 길이: WS 연결 상한 이상(세션마다 작업 하나 이하 — {@link #load} 의 after), 적어도 {@value #DEFAULT_QUEUE}. */
    static int queueFor(int wsMaxConn) { return SelectionLookups.queueFor(wsMaxConn); }

    /**
     * 운영 실행기: 데몬 스레드 threads 개(이름 ship-lookup-N — JDBC · Redis 를 기다린다) · 대기열 queue · 넘치면 거절(부르는 쪽이 읽지 못함으로 답한다).
     * 쉬는 스레드는 60 s 뒤 끝난다.
     */
    static ThreadPoolExecutor boundedExecutor(int threads, int queue) { return SelectionLookups.boundedExecutor(THREAD_NAME, threads, queue); }

    private final SelectionLookups engine;
    private volatile Source<String, StoredStaticReader.Lookup> stored;
    private volatile Source<ShipStatic, PortCallsInfo> portCalls;

    /**
     * @param executor   읽기를 돌릴 실행기(운영 {@link #boundedExecutor} — 시험은 바로 실행 · 가상 스레드)
     * @param deadlineMs 물음 → 답의 상한(운영: 읽기 풀이 답하는 한 번 읽기의 상한 — ReadPool.readBoundMs)
     */
    ShipLookups(Executor executor, long deadlineMs, MeterRegistry meters) {
        this.engine = new SelectionLookups("ship", "선택 선박 조회", executor, deadlineMs, meters);
    }

    void setStored(Source<String, StoredStaticReader.Lookup> s) { stored = s; }

    void setPortCalls(Source<ShipStatic, PortCallsInfo> s) { portCalls = s; }

    long deadlineMs() { return engine.deadlineMs(); }

    /** 답을 보내지 않은 조회(부르는 쪽 — 선택 · 물음이 바뀌었다, 세션이 닫혔다)를 센다. */
    void dropped() { engine.dropped(); }

    /** 메모리 정적 정보(live — 있으면 그것)와 읽는 쪽의 캐시만으로 답한다(I/O 없음). 한 부분이라도 읽어야 하면 null. */
    Resolved cached(String mmsi, ShipStatic live) {
        SelectedStatic sel;
        if (live != null) sel = new SelectedStatic(live, ShipJson.STATIC_LIVE);
        else {
            Source<String, StoredStaticReader.Lookup> s = stored;
            if (s == null) sel = UNKNOWN;
            else {
                StoredStaticReader.Lookup l = s.cached(mmsi);
                if (l == null) return null;
                sel = selected(l);
            }
        }
        Source<ShipStatic, PortCallsInfo> p = portCalls;
        if (p == null) return new Resolved(sel, null);
        PortCallsInfo c = p.cached(sel.stat());
        return c == null ? null : new Resolved(sel, c);
    }

    /**
     * 읽어서 답한다(부르는 쪽을 막지 않는다). 읽기는 after(세션의 앞 조회의 settled — 없거나 끝났으면 곧바로)가 끝난 뒤 시작하고, 올리기 직전마다 wanted 를
     * 묻는다(false 면 그 읽기를 하지 않는다 — skipped). 답은 늦어도 물음 뒤 {@link #deadlineMs} 에 온다(앞 조회를 기다린 시간도 포함). 바로 실행하는
     * 실행기면 돌아올 때 이미 끝나 있다.
     */
    Flight<Resolved> load(String mmsi, ShipStatic live, CompletableFuture<?> after, BooleanSupplier wanted) {
        Reads r = engine.begin(after, wanted);
        CompletableFuture<SelectedStatic> st = r.turn().thenCompose(x -> staticPart(mmsi, live, r));
        CompletableFuture<Resolved> all = st.thenCompose(sel -> callsPart(sel, r));
        return engine.flight(r, all, () -> fallback(st));
    }

    private CompletableFuture<SelectedStatic> staticPart(String mmsi, ShipStatic live, Reads r) {
        if (live != null) return CompletableFuture.completedFuture(new SelectedStatic(live, ShipJson.STATIC_LIVE));
        Source<String, StoredStaticReader.Lookup> s = stored;
        if (s == null) return CompletableFuture.completedFuture(UNKNOWN);
        StoredStaticReader.Lookup l = s.cached(mmsi);
        if (l != null) return CompletableFuture.completedFuture(selected(l));
        if (!r.wanted()) return CompletableFuture.completedFuture(UNAVAILABLE);
        return r.read(() -> s.load(mmsi, r.executor())).thenApply(v -> v == null ? UNAVAILABLE : selected(v));
    }

    private CompletableFuture<Resolved> callsPart(SelectedStatic sel, Reads r) {
        Source<ShipStatic, PortCallsInfo> p = portCalls;
        if (p == null) return CompletableFuture.completedFuture(new Resolved(sel, null));
        PortCallsInfo c = p.cached(sel.stat());
        if (c != null) return CompletableFuture.completedFuture(new Resolved(sel, c));
        if (!r.wanted()) return CompletableFuture.completedFuture(new Resolved(sel, unreadCalls(sel.stat())));
        return r.read(() -> p.load(sel.stat(), r.executor())).thenApply(v -> new Resolved(sel, v != null ? v : unreadCalls(sel.stat())));
    }

    /** 마감 · 예외 때의 답: 정적 부분이 끝났으면 그것, 아니면 읽지 못함. 입출항은 {@link #unreadCalls}. */
    private Resolved fallback(CompletableFuture<SelectedStatic> st) {
        SelectedStatic sel = st.isDone() && !st.isCompletedExceptionally() ? st.join() : UNAVAILABLE;
        return new Resolved(sel, unreadCalls(sel.stat()));
    }

    /**
     * 입출항을 (제때) 읽지 못했을 때의 답: 읽지 않고 답할 수 있으면(호출부호 없음 · 형식 밖 · 그사이 캐시에 들어온 값) 그것, 아니면 error(색인을 읽지 못함 —
     * '기록 없음' 이 아니다). 읽는 쪽이 없는 구성이면 null.
     */
    private PortCallsInfo unreadCalls(ShipStatic st) {
        Source<ShipStatic, PortCallsInfo> p = portCalls;
        if (p == null) return null;
        PortCallsInfo c = p.cached(st);
        if (c != null) return c;
        return st == null ? null : PortCallsInfo.error(PortCallReader.normalizeCallSign(st.callSign()));
    }

    static SelectedStatic selected(StoredStaticReader.Lookup l) {
        if (l == null) return UNKNOWN;
        return switch (l.status()) {
            case STORED -> new SelectedStatic(l.stat(), ShipJson.STATIC_STORED);
            case NONE -> new SelectedStatic(null, ShipJson.STATIC_NONE);
            case UNAVAILABLE -> UNAVAILABLE;
        };
    }

    @Override
    public void close() { engine.close(); }
}
