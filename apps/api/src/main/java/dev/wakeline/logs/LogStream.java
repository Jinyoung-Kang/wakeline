package dev.wakeline.logs;

import org.springframework.data.redis.connection.RedisStreamCommands.TrimOptions;
import org.springframework.data.redis.connection.RedisStreamCommands.XAddOptions;

/**
 * 시스템 로그 스트림 두 개(ADR-018 · 계약 v5 §G2). 항목 모양(log_event.v1)은 같고 싣는 곳 · 자르는 길이만 다르다.
 * <ul>
 *   <li>SERVER {@value LogSink#STREAM}(MAXLEN ~ {@value LogSink#MAXLEN}): api · collector · ais 의 WARN·ERROR.</li>
 *   <li>CLIENT {@value LogSink#CLIENT_STREAM}(MAXLEN ~ {@value LogSink#CLIENT_MAXLEN}): 누구나 보낼 수 있는 브라우저 오류(§C6, web-client) —
 *       따로 싣고 따로 자른다. 한 스트림이면 분당 120건(전체 한도)으로 약 25분에 서버 오류 3,000건이 모두 밀려났다.</li>
 * </ul>
 * 조회({@link LogReader})는 두 스트림을 id 순으로 합쳐 최신 순으로 보이고 항목마다 {@link #label()} 을 stream 으로 싣는다.
 * 같은 id 가 두 스트림에 있으면(같은 밀리초 · 같은 순번 — 스트림마다 따로 매긴다) 선언 순서(server → client)가 앞이다.
 */
public enum LogStream {
    SERVER(LogSink.STREAM, LogSink.MAXLEN, "server"),
    CLIENT(LogSink.CLIENT_STREAM, LogSink.CLIENT_MAXLEN, "client");

    private final String key;
    private final long maxlen;
    private final String label;
    private final XAddOptions xaddOptions;

    LogStream(String key, long maxlen, String label) {
        this.key = key;
        this.maxlen = maxlen;
        this.label = label;
        // 근사 트림(MAXLEN ~) — Redis 가 내부 노드(기본 100 항목) 단위로 자른다. 정확한 트림은 XADD 마다 노드를 다시 쓴다
        this.xaddOptions = XAddOptions.trim(TrimOptions.maxLen(maxlen).approximate());
    }

    /** Redis 키. */
    public String key() { return key; }

    /** XADD MAXLEN ~ 의 길이. */
    public long maxlen() { return maxlen; }

    /** 조회 응답의 항목 필드 stream · cursor 의 머리 값("server" | "client"). */
    public String label() { return label; }

    /** XADD … MAXLEN ~ {@link #maxlen()}. */
    public XAddOptions xaddOptions() { return xaddOptions; }

    /** label → 스트림. 모르는 값이면 null. */
    public static LogStream ofLabel(String label) {
        for (LogStream s : values()) if (s.label.equals(label)) return s;
        return null;
    }
}
