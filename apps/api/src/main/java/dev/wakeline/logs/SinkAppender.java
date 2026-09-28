package dev.wakeline.logs;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.UnsynchronizedAppenderBase;

/**
 * logback → {@link LogSink}. WARN 이상만, 그리고 재귀를 막는다(계약 v5 §C2):
 * <ul>
 *   <li>로그 패키지(dev.wakeline.logs.*) 자신의 로그는 싣지 않는다 — 싱크 실패를 싱크로 보내면 끝없이 돈다. 표준 출력에만 남는다.</li>
 *   <li>싱크 스레드에서 난 로그(XADD 중 Redis 클라이언트의 경고 등)도 싣지 않는다.</li>
 *   <li>항목을 만드는 동안 같은 스레드에서 다시 로그가 나면(가림·직렬화 라이브러리 등) 무시한다.</li>
 * </ul>
 * UnsynchronizedAppenderBase — 앱 스레드끼리 이 어펜더에서 줄 서지 않는다(싱크의 대기열 잠금만 잠깐).
 */
final class SinkAppender extends UnsynchronizedAppenderBase<ILoggingEvent> {
    static final String NAME = "WAKELINE_LOG_SINK";
    static final String OWN_PACKAGE = "dev.wakeline.logs.";
    private static final ThreadLocal<Boolean> INSIDE = new ThreadLocal<>();

    private final LogSink sink;

    SinkAppender(LogSink sink) {
        this.sink = sink;
        setName(NAME);
    }

    @Override
    protected void append(ILoggingEvent e) {
        Level level = e.getLevel();
        if (level == null || !level.isGreaterOrEqual(Level.WARN)) return;
        String logger = e.getLoggerName();
        if (logger != null && logger.startsWith(OWN_PACKAGE)) return;
        if (sink.isFlusherThread() || INSIDE.get() != null) return;
        INSIDE.set(Boolean.TRUE);
        try {
            sink.accept(e);
        } catch (Throwable t) {
            System.err.println("log sink: could not queue a log event: " + t); // 재귀 금지 — 표준 오류에만
        } finally {
            INSIDE.remove();
        }
    }
}
