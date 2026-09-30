package dev.wakeline.coverage;

import java.sql.SQLException;
import java.util.function.Consumer;

/**
 * 관측 수신 격자의 부트스트랩 원천(ADR-027): 저장된 위치(ship_position — 60 s 창마다 첫 보고)를 시 조각마다 칸 · MMSI 로 묶어 읽는다.
 * 운영은 {@link JdbcCoverageSource}(연결 하나 · 읽기 전용 · 상한), 시험은 가짜.
 */
public interface CoverageSource {
    /** 부트스트랩 한 번의 연결을 연다(끝나면 닫는다). */
    Session open() throws SQLException;

    interface Session extends AutoCloseable {
        /** [fromMs, toMs) 의 행을 sink 로 넘긴다(한 문장). 실패는 예외. */
        void read(long fromMs, long toMs, Consumer<Row> sink) throws SQLException;

        @Override
        void close() throws SQLException;
    }

    /**
     * 한 조각 안의 칸(floor(lon · 2) · floor(lat · 2)) · MMSI 하나: 저장된 위치 수와 그 가운데 가장 늦은 시각(ms).
     */
    record Row(int lonIdx, int latIdx, int mmsi, int positions, long lastMs) {}
}
