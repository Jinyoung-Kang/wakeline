package dev.wakeline.ops;

import dev.wakeline.config.Problem;
import dev.wakeline.logs.LogEvents;
import dev.wakeline.rest.StatusService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * 해결 표시(계약 v5 §G13 · ADR-022): 운영자가 로그 묶음(fp) · 공급자 오류를 "upto 까지 해결됨" 으로 적고, 조회가 그 이하를 가린다.
 * 증거는 지우지 않는다 — 로그 스트림 · ingest_run · 공급자 해시는 그대로 나이 들어 사라진다(보존 규칙 그대로).
 * <ul>
 *   <li>쓰기({@link #create} · {@link #revoke}): 행과 감사(RESOLVE · UNRESOLVE)가 한 트랜잭션 — 감사 없이 남은 해결도, 해결 없이 남은 감사도 없다.
 *       되돌림은 행을 지우지 않고 revoked_at · revoked_by 를 채운다. 커밋(또는 실패) 뒤 캐시를 바로 버린다 — 쓴 운영자의 다음 조회가 바로 반영한다.</li>
 *   <li>읽기({@link #active}): 활성 해결 전체를 {@value #TTL_S} s 이하 캐시한다(로그 조회는 15 s 마다 · Redis 만 읽는 경로에 요청마다 DB 를 더하지 않게).
 *       캐시를 채우는 읽기와 겹친 쓰기는 세대 번호로 가려 옛 값이 캐시에 남지 않는다.</li>
 *   <li>DB 를 읽지 못하면(장애 · {@value ResolutionRepository#READ_TIMEOUT_S} s 초과) 마지막으로 읽은 값을 STALE 로, 한 번도 읽지 못했으면
 *       UNAVAILABLE(아무것도 가리지 않는다)로 돌려주고 {@value #RETRY_S} s 뒤에 다시 읽는다 — 로그 조회(Redis)는 DB 장애 중에도 된다.
 *       응답은 resolution_state 로 이를 알리고, 실패는 WARN(처음 · 그 뒤 {@value #WARN_EVERY_S} s 마다)으로 시스템 로그에 남는다.</li>
 * </ul>
 */
@Service
public class ResolutionService {
    private static final Logger log = LoggerFactory.getLogger(ResolutionService.class);
    static final long TTL_S = 5;
    static final long RETRY_S = 30;
    static final long WARN_EVERY_S = 60;
    static final int NOTE_MAX = 200;
    /** 이보다 이른 upto 는 받지 않는다(이 저장소의 어떤 증거보다 이르다 — 입력 오류). */
    static final Instant UPTO_MIN = Instant.parse("2000-01-01T00:00:00Z");
    static final Set<String> FIELDS = Set.of("kind", "key", "upto", "note");
    private static final Pattern CONTROL = Pattern.compile("\\p{Cc}");

    /** 검증을 마친 해결 요청. upto 는 μs 로 자른 값(DB 정밀도 — 발생 ts 는 μs 이하라 자르면서 덮던 발생을 놓치지 않는다). */
    public record Draft(String kind, String key, Instant upto, String note) {}

    /** 감사 기록 콜백(같은 트랜잭션 안에서 불린다). target = "kind:key". */
    @FunctionalInterface
    public interface AuditHook { void record(String target, Object before, Object after); }

    private record Entry(long gen, long expiresAtNanos, Resolutions value) {}

    private final ResolutionRepository repo;
    private final TransactionTemplate tx;
    private final Supplier<Instant> clock;
    private final LongSupplier nanos;
    private final AtomicLong gen = new AtomicLong();
    private final Object loadLock = new Object();
    private volatile Entry entry;
    /** 마지막으로 DB 에서 읽은 값(읽기 실패 때 STALE 로). loadLock 안에서만 쓴다. */
    private Resolutions lastGood;
    /** 읽기 실패가 이어지는 동안 마지막 WARN 시각(nanos) — 없으면 null. loadLock 안에서만. */
    private Long failingWarnedAt;

    @Autowired
    public ResolutionService(ResolutionRepository repo, TransactionTemplate tx) {
        this(repo, tx, Instant::now, System::nanoTime);
    }

    ResolutionService(ResolutionRepository repo, TransactionTemplate tx, Supplier<Instant> clock, LongSupplier nanos) {
        this.repo = repo;
        this.tx = tx;
        this.clock = clock;
        this.nanos = nanos;
    }

    // ---------------------------------------------------------------- 요청 본문

    /** 본문 JSON 읽기: 같은 키가 두 번이면 틀림(어느 값이 쓰였는지 모호하다). */
    private static final JsonMapper BODY = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build();
    /** 본문 상한(글자) — 네 필드에 넉넉하다. */
    static final int BODY_MAX = 4096;

    /** POST 본문 글자 → {@link #parse(JsonNode)}. 비었거나 JSON 이 아니거나 {@value #BODY_MAX}자를 넘으면 400 BAD_RESOLUTION. */
    public Draft parse(String body) {
        if (body == null || body.isBlank()) throw bad("body must be a JSON object {kind, key, upto?, note?}");
        if (body.length() > BODY_MAX) throw bad("body must be at most " + BODY_MAX + " characters");
        JsonNode n;
        try {
            n = BODY.readTree(body);
        } catch (JacksonException e) {
            throw bad("body must be one JSON object {kind, key, upto?, note?} without repeated fields");
        }
        return parse(n);
    }

    /**
     * POST 본문 {kind, key, upto?, note?} → {@link Draft}. 규칙(틀리면 400 BAD_RESOLUTION): 모르는 필드는 거절(오타가 조용히 기본값 — 지금까지
     * 모두 가림 — 이 되지 않게) · kind 는 log_group | provider_error · key 는 kind 에 맞게(fp 16자리 소문자 16진 | 운영 공급자 이름, 앞뒤 공백도 틀림) ·
     * upto 는 시간대가 있는 ISO 시각(없거나 null 이면 지금), 미래 · 2000-01-01 이전은 틀림 · note 는 앞뒤 공백을 뗀 200 글자(코드 포인트) 이하,
     * 제어 문자 없음(빈 글이면 null).
     */
    public Draft parse(JsonNode body) {
        if (body == null || !body.isObject()) throw bad("body must be a JSON object {kind, key, upto?, note?}");
        for (String f : body.propertyNames())
            if (!FIELDS.contains(f)) throw bad("unknown field: " + (f.length() > 40 ? f.substring(0, 40) + "…" : f) + " (allowed: kind, key, upto, note)");
        String kind = string(body, "kind");
        if (!Resolution.LOG_GROUP.equals(kind) && !Resolution.PROVIDER_ERROR.equals(kind)) throw bad("kind must be log_group or provider_error");
        String key = string(body, "key");
        if (key == null) throw bad("key is required (a log fingerprint or a provider name)");
        if (Resolution.LOG_GROUP.equals(kind) && !LogEvents.FP.matcher(key).matches()) throw bad("key of a log_group must be 16 lowercase hex digits (fp)");
        if (Resolution.PROVIDER_ERROR.equals(kind) && !StatusService.PROVIDERS.contains(key))
            throw bad("key of a provider_error must be one of the providers: " + String.join(", ", StatusService.PROVIDERS));
        Instant now = clock.get();
        Instant upto = uptoOf(body.get("upto"), now);
        return new Draft(kind, key, upto, noteOf(body.get("note")));
    }

    private static Instant uptoOf(JsonNode v, Instant now) {
        if (v == null || v.isNull()) return now.truncatedTo(ChronoUnit.MICROS);
        Instant t;
        try {
            if (!v.isString()) throw new DateTimeParseException("not a string", String.valueOf(v), 0);
            t = OffsetDateTime.parse(v.asString()).toInstant().truncatedTo(ChronoUnit.MICROS);
        } catch (DateTimeParseException e) {
            throw bad("upto must be an ISO 8601 date-time with an offset (e.g. 2026-09-29T03:04:05.678Z)");
        }
        if (t.isAfter(now)) throw bad("upto must not be in the future");
        if (t.isBefore(UPTO_MIN)) throw bad("upto must not be before 2000-01-01T00:00:00Z");
        return t;
    }

    private static String noteOf(JsonNode v) {
        if (v == null || v.isNull()) return null;
        if (!v.isString()) throw bad("note must be a string or null");
        String s = v.asString().strip();
        if (s.isEmpty()) return null;
        if (s.codePointCount(0, s.length()) > NOTE_MAX) throw bad("note must be at most " + NOTE_MAX + " characters");
        if (CONTROL.matcher(s).find()) throw bad("note must be one line without control characters");
        return s;
    }

    private static String string(JsonNode body, String field) {
        JsonNode v = body.get(field);
        return v != null && v.isString() ? v.asString() : null;
    }

    private static Problem bad(String detail) { return Problem.badRequest("BAD_RESOLUTION", detail); }

    // ---------------------------------------------------------------- 쓰기

    /** 해결 + 감사 RESOLVE(before null, after = 행) 한 트랜잭션. 끝나면(실패해도) 캐시를 버린다. */
    public Resolution create(Draft d, String user, AuditHook audit) {
        try {
            return tx.execute(st -> {
                Resolution r = repo.insert(d.kind(), d.key(), d.upto(), user, d.note());
                audit.record(target(r), null, r);
                return r;
            });
        } finally {
            invalidate();
        }
    }

    /**
     * 되돌림 + 감사 UNRESOLVE(before = 행, after = {id, revoked_at, revoked_by}) 한 트랜잭션. 없는 id · 이미 되돌린 행은 404(감사 없음).
     * 행은 지우지 않는다.
     */
    public void revoke(long id, String user, AuditHook audit) {
        ResolutionRepository.Revoked done;
        try {
            done = tx.execute(st -> {
                ResolutionRepository.Revoked rv = repo.revoke(id, user);
                if (rv == null) return null;
                Map<String, Object> after = new LinkedHashMap<>();
                after.put("id", id);
                after.put("revoked_at", rv.revokedAt());
                after.put("revoked_by", rv.revokedBy());
                audit.record(target(rv.resolution()), rv.resolution(), after);
                return rv;
            });
        } finally {
            invalidate();
        }
        if (done == null) throw Problem.notFound("no such active resolution (unknown id, or already revoked)");
    }

    private static String target(Resolution r) { return r.kind() + ":" + r.key(); }

    // ---------------------------------------------------------------- 읽기(캐시)

    /** 캐시를 버린다(쓰기 뒤). 이 순간에 진행 중인 읽기의 결과는 캐시에 남지 않는다(세대 번호). */
    void invalidate() {
        gen.incrementAndGet();
        entry = null;
    }

    /** 활성 해결({@value #TTL_S} s 이하 캐시 — 클래스 설명). 예외를 던지지 않는다. */
    public Resolutions active() {
        Entry e = entry;
        if (fresh(e)) return e.value();
        synchronized (loadLock) { // 한 번에 한 읽기 — 만료 순간 요청이 몰려도 DB 를 한 번만 부른다
            e = entry;
            if (fresh(e)) return e.value();
            long g = gen.get();
            long started = nanos.getAsLong();
            Resolutions value;
            long expires;
            try {
                value = Resolutions.of(repo.active(), Resolutions.State.OK);
                lastGood = value;
                expires = started + Duration.ofSeconds(TTL_S).toNanos();
                if (failingWarnedAt != null) log.info("ops resolutions are readable again — hiding resolved errors with the current database state");
                failingWarnedAt = null;
            } catch (RuntimeException ex) {
                value = lastGood == null ? Resolutions.unavailable() : lastGood.withState(Resolutions.State.STALE);
                long now = nanos.getAsLong();
                expires = now + Duration.ofSeconds(RETRY_S).toNanos();
                if (failingWarnedAt == null || now - failingWarnedAt >= Duration.ofSeconds(WARN_EVERY_S).toNanos()) {
                    failingWarnedAt = now;
                    log.warn("ops resolutions could not be read ({}) — {} until the database answers (retry in {} s): {}", ex.getClass().getSimpleName(),
                            lastGood == null ? "nothing is hidden" : "hiding with the last snapshot read", RETRY_S, ex.getMessage());
                }
            }
            if (gen.get() == g) entry = new Entry(g, expires, value); // 읽는 동안 쓰기가 있었으면 남기지 않는다
            return value;
        }
    }

    private boolean fresh(Entry e) {
        return e != null && e.gen() == gen.get() && nanos.getAsLong() - e.expiresAtNanos() < 0;
    }
}
