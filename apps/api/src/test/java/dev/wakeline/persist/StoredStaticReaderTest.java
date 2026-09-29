package dev.wakeline.persist;

import dev.wakeline.domain.ShipStatic;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 저장된 AIS 정적 보고 읽기(static-fallback · 계약 v5 §G17): 결과 세 가지(stored · none · unavailable), 캐시(찾음 · 없음 60 s, 실패 15 s), 같은 값이면
 * 같은 객체, 캐시 상한, 운영 연결(ShipRepository.find — 위치로만 만든 행은 정적 보고가 아니다), 지표. 예외는 밖으로 나가지 않는다.
 */
class StoredStaticReaderTest {
    static final Instant T = Instant.parse("2026-09-29T08:00:00Z");

    static ShipStatic stat(String mmsi, String callSign, Instant updatedAt) {
        return new ShipStatic(mmsi, "SYNTH " + mmsi, callSign, null, 60, null, null, null, null, null, null, null, null, null, null, updatedAt, "aisstream");
    }

    /** MMSI → 행(없으면 null), fail 이면 던진다. 읽은 MMSI 를 적는다. */
    static final class Db implements StoredStaticReader.Source {
        final Map<String, ShipStatic> rows = new HashMap<>();
        RuntimeException fail;
        final List<String> reads = new ArrayList<>();

        @Override public ShipStatic find(String mmsi) {
            reads.add(mmsi);
            if (fail != null) throw fail;
            return rows.get(mmsi);
        }
    }

    @Test void storedNoneUnavailable_areCachedForTheirOwnTtl() {
        Db db = new Db();
        AtomicLong clock = new AtomicLong(10_000_000);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        StoredStaticReader r = new StoredStaticReader(db, clock::get, meters);
        db.rows.put("440000031", stat("440000031", "V7A3884", T));

        StoredStaticReader.Lookup found = r.lookup("440000031");
        assertThat(found.status()).isEqualTo(StoredStaticReader.Status.STORED);
        assertThat(found.stat().callSign()).isEqualTo("V7A3884");
        assertThat(found.stat().updatedAt()).as("the row's updated_at, as stored").isEqualTo(T);
        assertThat(r.lookup("440000032")).isSameAs(StoredStaticReader.Lookup.NONE);
        db.fail = new QueryTimeoutException("statement timeout");
        assertThat(r.lookup("440000033")).isSameAs(StoredStaticReader.Lookup.UNAVAILABLE);
        assertThat(db.reads).containsExactly("440000031", "440000032", "440000033");

        // 캐시 안: 다시 읽지 않는다(실패 중이어도 찾은 것 · 없는 것은 그대로)
        clock.addAndGet(StoredStaticReader.ERROR_TTL_MS - 1);
        assertThat(r.lookup("440000031")).isSameAs(found);
        assertThat(r.lookup("440000032")).isSameAs(StoredStaticReader.Lookup.NONE);
        assertThat(r.lookup("440000033")).isSameAs(StoredStaticReader.Lookup.UNAVAILABLE);
        assertThat(db.reads).hasSize(3);
        // 실패는 짧게만 기억한다 — DB 가 돌아오면 다음 선택 · 주기 다시 보기가 찾는다
        db.fail = null;
        db.rows.put("440000033", stat("440000033", "D7AI", T));
        clock.addAndGet(1);
        assertThat(r.lookup("440000033").status()).isEqualTo(StoredStaticReader.Status.STORED);
        assertThat(r.lookup("440000031")).as("found stays cached for TTL_MS").isSameAs(found);
        assertThat(db.reads).hasSize(4);

        // 캐시가 지남: 다시 읽는다 — 같은 값(새 객체)이면 같은 객체를 돌려준다(받는 쪽이 바뀌지 않은 것을 다시 보내지 않게)
        clock.addAndGet(StoredStaticReader.TTL_MS);
        db.rows.put("440000031", stat("440000031", "V7A3884", T));
        assertThat(r.lookup("440000031")).isSameAs(found);
        // 바뀐 값(새 정적 보고가 저장됐다)은 새 결과
        clock.addAndGet(StoredStaticReader.TTL_MS);
        db.rows.put("440000031", stat("440000031", "V7A3885", T.plusSeconds(60)));
        assertThat(r.lookup("440000031").stat().callSign()).isEqualTo("V7A3885");
        // 시계가 뒤로 가면 믿지 않고 다시 읽는다
        int before = db.reads.size();
        clock.addAndGet(-1_000);
        r.lookup("440000031");
        assertThat(db.reads).hasSize(before + 1);

        assertThat(meters.counter("wakeline_stored_static_errors_total").count()).isEqualTo(1.0);
        assertThat(meters.counter("wakeline_cache_requests_total", "cache", "stored_static", "result", "hit").count()).isEqualTo(4.0);
        assertThat(meters.counter("wakeline_cache_requests_total", "cache", "stored_static", "result", "miss").count()).isEqualTo(db.reads.size());
    }

    @Test void anyRuntimeFailureIsUnavailable_neverThrown() {
        Db db = new Db();
        StoredStaticReader r = new StoredStaticReader(db, () -> 0, new SimpleMeterRegistry());
        db.fail = new IllegalStateException("pool closed");
        assertThat(r.lookup("440000034")).isSameAs(StoredStaticReader.Lookup.UNAVAILABLE);
    }

    @Test void aRowWithoutAStaticReportIsNone() {
        Db db = new Db();
        db.rows.put("440000035", stat("440000035", "D7AJ", null)); // updated_at 없음 = 정적 보고를 받은 적 없는 행
        assertThat(new StoredStaticReader(db, () -> 0, new SimpleMeterRegistry()).lookup("440000035")).isSameAs(StoredStaticReader.Lookup.NONE);
    }

    @Test void theCacheIsBounded_expiredEntriesGoFirst_thenEverything() {
        Db db = new Db();
        AtomicLong clock = new AtomicLong(0);
        StoredStaticReader r = new StoredStaticReader(db, clock::get, new SimpleMeterRegistry());
        for (int i = 0; i < StoredStaticReader.MAX_ENTRIES; i++) r.lookup(String.format("44%07d", i));
        assertThat(r.cached()).isEqualTo(StoredStaticReader.MAX_ENTRIES);
        clock.addAndGet(StoredStaticReader.TTL_MS); // 모두 만료 → 치우고 새 것 하나
        r.lookup("449999999");
        assertThat(r.cached()).isEqualTo(1);
        for (int i = 1; i < StoredStaticReader.MAX_ENTRIES; i++) r.lookup(String.format("45%07d", i));
        r.lookup("459999999"); // 모두 신선한데 상한 — 비우고 새 것 하나
        assertThat(r.cached()).isEqualTo(1);
    }

    /** 운영 연결: ShipRepository.find 의 행 → 정적 정보(위치로만 만든 행은 stat null → none), DB 예외 → unavailable. */
    @Test void productionSourceReadsTheShipRow() {
        ShipRepository repo = mock(ShipRepository.class);
        ShipStatic st = stat("440000036", "V7A3884", T);
        when(repo.find("440000036")).thenReturn(new ShipRepository.StoredShip(st, T.minusSeconds(86_400), T));
        when(repo.find("440000037")).thenReturn(new ShipRepository.StoredShip(null, T.minusSeconds(86_400), T));
        when(repo.find("440000038")).thenReturn(null);
        when(repo.find("440000039")).thenThrow(new CannotGetJdbcConnectionException("down"));
        StoredStaticReader r = new StoredStaticReader(repo, new SimpleMeterRegistry());
        assertThat(r.lookup("440000036")).isEqualTo(StoredStaticReader.Lookup.stored(st));
        assertThat(r.lookup("440000037")).isSameAs(StoredStaticReader.Lookup.NONE);
        assertThat(r.lookup("440000038")).isSameAs(StoredStaticReader.Lookup.NONE);
        assertThat(r.lookup("440000039")).isSameAs(StoredStaticReader.Lookup.UNAVAILABLE);
    }
}
