package dev.wakeline.platform.web;

import dev.wakeline.platform.support.LogMasker;
import io.lettuce.core.RedisLoadingException;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.NonTransientDataAccessResourceException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.dao.RecoverableDataAccessException;
import org.springframework.dao.TransientDataAccessException;
import org.springframework.data.redis.RedisSystemException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.UncategorizedSQLException;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.web.ErrorResponse;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.WebDataBinder;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.InitBinder;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.util.DisconnectedClientHelper;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.net.URI;
import java.sql.SQLException;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 모든 오류를 application/problem+json(RFC 9457)으로. 확장 필드 code · request_id. 스택·내부 메시지는 싣지 않는다.
 * <ul>
 *   <li>DB·Redis 연결 실패·풀 대기 초과·일시 오류 → 503 + Retry-After: 10 (5.1절 'DB 종료·느림', 계약 §2). WARN 한 줄(스택 없음) — 원인은 예외가
 *       스스로 말하는 것(SQLSTATE · 예외 종류)만, 그리고 경로 + 쿼리 문자열(가림 규칙을 거쳐) · 걸린 시간 · 공개 조회면 끊긴 문장의 이름과 그 한도
 *       (호출부의 이름표 — Sql.publicRead)를 싣는다(조사 2026-10-01 오류 F3). 컨트롤러가 DB 없이 답하는 길(503 · meta.db_unavailable)도 같은 줄을
 *       남긴다({@link #storeUnavailable} · {@link #answeredWithoutStore}).
 *       잠금 대기 한도(SQLSTATE 55P03)는 Spring 의 기본 번역이 모르는 부류라 UncategorizedSQLException 으로 오지만 같은 503 이다(예전: 500 + ERROR).
 *       Redis 가 기동하며 데이터를 읽는 동안의 LOADING 답도 분류되지 않은 RedisSystemException 으로 오지만 같은 503 이다.</li>
 *   <li>Spring MVC 가 이미 상태를 아는 예외(405·406·415 등, {@link ErrorResponse}) → 그 상태 그대로, 헤더(Allow 등) 유지.
 *       4xx 는 INFO 한 줄 — 익명 요청으로 ERROR 스택을 쏟아내게 할 수 없다(SEC-10).</li>
 *   <li>그 밖의 예외만 500 + ERROR(스택).</li>
 * </ul>
 * 모든 컨트롤러가 이 advice 를 받으므로 요청 파라미터의 공통 입력 규칙도 여기서 바인더에 단다: 시각 · 날짜 파라미터의 범위({@link TimeParams} —
 * 밖이면 400, 계약 v5 §G32).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestControllerAdvice
public class ProblemAdvice {
    private static final Logger log = LoggerFactory.getLogger(ProblemAdvice.class);
    /** PostgreSQL SQLSTATE 57014 query_canceled(pgjdbc PSQLState.QUERY_CANCELED) — 쿼리 한도(setQueryTimeout)가 보낸 취소 · 서버 statement_timeout. */
    static final String QUERY_CANCELED = "57014";
    /** PostgreSQL SQLSTATE 55P03 lock_not_available — lock_timeout(application.yml 5 s) · NOWAIT. Spring sql-error-codes.xml 의 PostgreSQL cannotAcquireLockCodes. */
    static final String LOCK_NOT_AVAILABLE = "55P03";
    /** 로그에 싣는 쿼리 문자열의 상한(코드 포인트). */
    static final int QUERY_LOG_MAX = 512;

    /** 시각 · 날짜 요청 파라미터의 범위(QA-207 · QA-201 · QA-202 · QA-208) — 모든 컨트롤러의 @RequestParam · @PathVariable 바인더에. */
    @InitBinder
    void timeParams(WebDataBinder binder) { TimeParams.register(binder); }

    @ExceptionHandler(Problem.class)
    ResponseEntity<ProblemDetail> problem(Problem e, HttpServletRequest req) {
        return withRetryAfter(build(e.status(), e.code(), e.title(), e.getMessage(), req), e.retryAfterS());
    }

    @ExceptionHandler({MissingServletRequestParameterException.class, MethodArgumentTypeMismatchException.class,
            HttpMessageNotReadableException.class, MethodArgumentNotValidException.class, HandlerMethodValidationException.class})
    ResponseEntity<ProblemDetail> badRequest(Exception e, HttpServletRequest req) {
        String detail = e instanceof MissingServletRequestParameterException m ? "missing parameter: " + m.getParameterName()
                : e instanceof MethodArgumentTypeMismatchException t ? "invalid parameter: " + t.getName() + outOfRange(t)
                : "invalid request";
        return build(HttpStatus.BAD_REQUEST, "BAD_REQUEST", "bad request", detail, req);
    }

    /** 형 변환 실패가 범위 밖 시각 · 날짜({@link TimeParams.OutOfRange})면 받는 범위를 덧붙인다(그 밖은 빈 글자 — 예전 detail 그대로). */
    static String outOfRange(Throwable e) {
        for (Throwable c = e.getCause(); c != null; c = c.getCause() == c ? null : c.getCause())
            if (c instanceof TimeParams.OutOfRange r) return " — " + r.getMessage();
        return "";
    }

    @ExceptionHandler(NoResourceFoundException.class)
    ResponseEntity<ProblemDetail> notFound(NoResourceFoundException e, HttpServletRequest req) {
        return build(HttpStatus.NOT_FOUND, "NOT_FOUND", "not found", "no such resource", req);
    }

    /**
     * 저장소(DB·Redis)를 지금 쓸 수 없다 — 서버 버그가 아니므로 스택 없이 한 줄, 클라이언트에는 재시도 간격을 준다.
     * 줄: {원인} request_id=… path=… [query="…"] elapsed_ms=… → 503: {예외 종류 ← 가장 안쪽 원인: 메시지}.
     */
    @ExceptionHandler({DataAccessResourceFailureException.class, NonTransientDataAccessResourceException.class,
            TransientDataAccessException.class, RecoverableDataAccessException.class, CannotCreateTransactionException.class})
    ResponseEntity<ProblemDetail> unavailable(Exception e, HttpServletRequest req) {
        warnUnavailable(e, req, ANSWERED_503);
        return withRetryAfter(build(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE", "service unavailable",
                "data store temporarily unavailable; retry later", req), Problem.UNAVAILABLE_RETRY_AFTER_S);
    }

    /** WARN 줄의 '무엇으로 답했는지': 503(Retry-After). */
    static final String ANSWERED_503 = "503";
    /** WARN 줄의 '무엇으로 답했는지': 저장소 없이 200(실시간 결과만 — meta.db_unavailable = true). */
    static final String ANSWERED_WITHOUT_STORE = "200 without stored data (meta.db_unavailable)";

    /**
     * 저장소를 지금 쓸 수 없다는 예외인가 — 처리기가 {@link #unavailable} 로 보내는 것과 같은 판정(예외 종류 + 잠금 대기 한도 55P03). 그 밖의 DB 예외
     * (문법 · 권한 · 제약 등)는 결함일 수 있다 — 500 + ERROR 로 남아야 한다.
     */
    public static boolean isUnavailable(Throwable e) {
        return e instanceof DataAccessResourceFailureException || e instanceof NonTransientDataAccessResourceException
                || e instanceof TransientDataAccessException || e instanceof RecoverableDataAccessException
                || e instanceof CannotCreateTransactionException
                || (e instanceof UncategorizedSQLException && LOCK_NOT_AVAILABLE.equals(sqlState(e))) || redisLoading(e);
    }

    /**
     * Redis 가 기동하며 AOF 를 읽는 동안 명령마다 '-LOADING' 으로 답한다(appendonly — 배포 때 redis 를 다시 만들면 매번). Lettuce 는 RedisLoadingException
     * 으로, Spring Data Redis 의 번역은 분류되지 않은 RedisSystemException 으로 감싼다 — 잠시 뒤 되는 일이라 503(리뷰 cto-2026-10 최종 리뷰: 레이더 프레임
     * 영상이 500 + ERROR 스택이었다). 다른 Redis 명령 오류(WRONGTYPE 등)는 결함일 수 있어 그대로 500.
     */
    static boolean redisLoading(Throwable e) {
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause()) if (c instanceof RedisLoadingException) return true;
        return false;
    }

    @ExceptionHandler(RedisSystemException.class)
    ResponseEntity<?> redisSystem(RedisSystemException e, HttpServletRequest req) {
        return redisLoading(e) ? unavailable(e, req) : other(e, req);
    }

    /**
     * 컨트롤러가 DB 없이 답할 때(200 + meta.db_unavailable — 실시간 결과만, 계약 §2): 저장소를 못 쓰는 예외면 {@link #unavailable} 과 같은 모양의
     * WARN 한 줄을 남기고 돌아온다. 그 밖의 예외(결함)는 그대로 던진다 → 500 + ERROR(db_unavailable 로 삼키지 않는다 — 리뷰 2026-10-01).
     */
    public static void answeredWithoutStore(RuntimeException e, HttpServletRequest req) {
        if (!isUnavailable(e)) throw e;
        warnUnavailable(e, req, ANSWERED_WITHOUT_STORE);
    }

    /**
     * 컨트롤러가 DB 없이는 답할 수 없을 때(실시간 상태도 없어 있는지 모른다): 저장소를 못 쓰는 예외면 WARN 한 줄을 남기고 503 Problem(detail ·
     * Retry-After)을 돌려준다. 그 밖의 예외(결함)는 그대로 돌려준다 — 부르는 쪽이 던진다(→ 500 + ERROR).
     */
    public static RuntimeException storeUnavailable(RuntimeException e, HttpServletRequest req, String detail) {
        if (!isUnavailable(e)) return e;
        warnUnavailable(e, req, ANSWERED_503);
        return Problem.unavailable(detail);
    }

    /**
     * 저장소를 못 써서 503 또는 DB 없이 답한 요청의 WARN 한 줄(스택 없음):
     * {원인} request_id=… path=… [query="…"] elapsed_ms=… [statement=… statement_limit_s=…] → {무엇으로 답했는지}: {예외 종류 ← 가장 안쪽 원인: 메시지}.
     */
    static void warnUnavailable(Throwable e, HttpServletRequest req, String answered) {
        Long elapsed = RequestIdFilter.elapsedMs(req);
        log.warn("{} request_id={} path={}{} elapsed_ms={}{} → {}: {}", cause(e), RequestIdFilter.current(req), req.getRequestURI(), query(req),
                elapsed == null ? "-" : elapsed, statement(e), answered, brief(e));
    }

    /** Sql.tag 가 SQL 앞 주석으로 싣는 문장 이름표(이름 · 그 문장의 한도). Spring 은 실패한 문장의 SQL 을 예외 메시지('SQL [...]')에 싣는다. */
    private static final Pattern STATEMENT_TAG = Pattern.compile("/\\* wakeline ([a-z0-9_.]{1,64}) limit_s=([0-9]{1,4}) \\*/");

    /**
     * 로그용: 실패한 문장의 이름과 그 문장에 걸린 한도 — 호출부가 붙인 이름표(Sql.publicRead)에서만 읽는다(조사 2026-10-01 오류 F3 · 도전 better_fix).
     * 한도는 그 문장의 설정값이다(끊긴 까닭이 그 한도라는 뜻은 아니다 — 원인 메시지와 elapsed_ms 가 말한다). 이름표가 없으면(연결을 얻기 전의 실패,
     * 공개 조회가 아닌 문장) 빈 글자 — 짐작해 적지 않는다.
     */
    public static String statement(Throwable e) {
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause()) {
            String m = c.getMessage();
            if (m == null) continue;
            Matcher x = STATEMENT_TAG.matcher(m);
            if (x.find()) return " statement=" + x.group(1) + " statement_limit_s=" + x.group(2);
        }
        return "";
    }

    /**
     * Spring 의 기본 예외 번역(SQLExceptionSubclassTranslator → SQLStateSQLExceptionTranslator)이 모르는 SQLSTATE. 잠금 대기 한도(55P03)는 잠시 뒤
     * 되는 일이라 503(DbTimeoutsIT 가 실제 DB 로 확인 — 예전에는 500 + ERROR 스택). 그 밖의 것은 결함일 수 있어 그대로 500.
     */
    @ExceptionHandler(UncategorizedSQLException.class)
    ResponseEntity<?> uncategorizedSql(UncategorizedSQLException e, HttpServletRequest req) {
        return LOCK_NOT_AVAILABLE.equals(sqlState(e)) ? unavailable(e, req) : other(e, req);
    }

    /**
     * 로그의 첫 마디 — 예외가 스스로 말하는 원인만(SQLSTATE · 예외 종류). 호출부가 알려 준 적 없는 한도나 까닭은 적지 않는다: 57014 는 문장마다 거는
     * JDBC 쿼리 한도(공개 조회 3 s — pgjdbc 가 취소를 보내면 'due to user request')일 수도, 서버의 statement_timeout('due to statement timeout' —
     * 공유 풀 연결은 30 s, 선택 조회 읽기 풀(ReadPool) 연결은 3 s)일 수도 있다. 어느 쪽인지는 뒤따르는 원인 메시지와 elapsed_ms 가 말한다.
     * CannotGetJdbcConnectionException 은 풀 대기 초과일 수도 DB 연결 실패일 수도 있다(원인 메시지 · SQLSTATE 가 말한다).
     * CannotCreateTransactionException 은 트랜잭션(운영 쓰기의 TransactionTemplate)용 연결을 열지 못한 것 — 풀 대기 초과도 이렇게 온다.
     * 그 밖의 SQLSTATE(예: 교착 40P01 — Spring 은 부류 40 을 잠금 실패로 번역한다)는 저장소가 '없다' 고 하지 않고 그 SQLSTATE 로 적는다.
     */
    static String cause(Throwable e) {
        String state = sqlState(e);
        if (QUERY_CANCELED.equals(state)) return "statement cancelled (SQLSTATE " + QUERY_CANCELED + ")";
        if (LOCK_NOT_AVAILABLE.equals(state)) return "lock not available (SQLSTATE " + LOCK_NOT_AVAILABLE + ")";
        if (redisLoading(e)) return "redis loading its dataset";
        String withState = state == null ? "" : " (SQLSTATE " + state + ")";
        if (e instanceof CannotGetJdbcConnectionException) return "could not get a DB connection" + withState;
        if (e instanceof CannotCreateTransactionException) return "could not open a DB connection for a transaction" + withState;
        if (e instanceof QueryTimeoutException) return "query timeout" + withState; // SQLSTATE 없음 — 예: Redis 명령 시간 초과
        if (state != null) return "DB error (SQLSTATE " + state + ")";
        return "data store unavailable";
    }

    /** SQLSTATE 모양(영숫자 대문자 5자) — 로그에 싣는 값을 이 모양으로만. */
    private static final Pattern SQLSTATE = Pattern.compile("[0-9A-Z]{5}");

    /** 원인 사슬에서 처음 만난 SQLSTATE(없거나 모양이 아니면 null). */
    static String sqlState(Throwable e) {
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause()) {
            if (c instanceof SQLException s && s.getSQLState() != null) return SQLSTATE.matcher(s.getSQLState()).matches() ? s.getSQLState() : null;
        }
        return null;
    }

    /**
     * 로그용 쿼리 문자열(없으면 빈 글자): 무엇을 물었는지 — 공개 API 의 쿼리는 bbox · 시각 · 개수 · 검색어 · 커서다. 그래도 로그 가림 규칙(LogMasker —
     * 계약 v5 §C5, 싱크로 가는 줄과 같은 규칙)을 거치고, 따옴표 안에 싣는다(로그 지문 — LogEvents.template 이 따옴표 안을 '…' 로 바꾼다 — 이 bbox ·
     * 시각 값마다 갈리지 않게). {@value #QUERY_LOG_MAX} 코드 포인트에서 자르고 잘라 낸 수를 적는다.
     */
    static String query(HttpServletRequest req) {
        String q = req.getQueryString();
        if (q == null || q.isEmpty()) return "";
        String masked = LogMasker.maskAll(q).replace("\"", "%22");
        int n = masked.codePointCount(0, masked.length());
        if (n > QUERY_LOG_MAX) masked = masked.substring(0, masked.offsetByCodePoints(0, QUERY_LOG_MAX)) + "…(+" + (n - QUERY_LOG_MAX) + ")";
        return " query=\"" + masked + "\"";
    }

    /** 클라이언트가 이미 연결을 끊어 응답을 쓸 수 없다 — 보낼 것도, 오류로 남길 것도 없다. */
    @ExceptionHandler(AsyncRequestNotUsableException.class)
    void clientGone(AsyncRequestNotUsableException e, HttpServletRequest req) {
        log.debug("response not usable (client gone) path={}", req.getRequestURI());
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<?> other(Exception e, HttpServletRequest req) {
        if (e instanceof ErrorResponse er) return springError(e, er, req);
        // 응답을 쓰는 중 클라이언트가 떠났다(Broken pipe · connection reset — 쓰기 실패가 HttpMessageNotWritableException 등으로 감싸져 온다).
        // 서버 결함이 아니고 보낼 곳도 없다 — ERROR 로 남기면 운영 · 로그 화면에 오류로 보인다(2026-09-30 배포 뒤 /ships/{mmsi}/track 4건).
        // 판정은 Spring 의 DisconnectedClientHelper(예외 이름 · 메시지 · 원인 사슬, 나가는 호출 · DB 예외는 제외)
        if (DisconnectedClientHelper.isClientDisconnectedException(e)) {
            log.debug("client gone while writing the response path={}: {}", req.getRequestURI(), brief(e));
            return null;
        }
        log.error("unhandled error request_id={} path={}", RequestIdFilter.current(req), req.getRequestURI(), e);
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL", "internal error", "unexpected error", req);
    }

    /** Spring MVC 가 상태를 정한 예외(405 Method Not Allowed · 406 · 415 · 413 등) — 그 상태와 헤더를 그대로 돌려준다. */
    static ResponseEntity<?> springError(Exception e, ErrorResponse er, HttpServletRequest req) {
        HttpStatusCode sc = er.getStatusCode();
        HttpStatus st = HttpStatus.resolve(sc.value());
        if (st == null) st = sc.is4xxClientError() ? HttpStatus.BAD_REQUEST : HttpStatus.INTERNAL_SERVER_ERROR;
        if (st.is5xxServerError()) log.warn("{} {} {} request_id={}: {}", st.value(), req.getMethod(), req.getRequestURI(), RequestIdFilter.current(req), e.getClass().getSimpleName());
        else log.info("client error {} {} {} request_id={}: {}", st.value(), req.getMethod(), req.getRequestURI(), RequestIdFilter.current(req), e.getClass().getSimpleName());
        HttpHeaders headers = new HttpHeaders();
        headers.putAll(er.getHeaders());
        // 406: 클라이언트가 받을 수 있는 형식이 없다 — problem+json 본문을 붙이면 다시 406 이 된다. 상태만.
        if (e instanceof HttpMediaTypeNotAcceptableException) return ResponseEntity.status(st).headers(headers).build();
        String title = st.getReasonPhrase().toLowerCase(Locale.ROOT);
        ProblemDetail pd = build(st, st.name(), title, title, req).getBody();
        headers.setContentType(MediaType.APPLICATION_PROBLEM_JSON);
        return ResponseEntity.status(st).headers(headers).body(pd);
    }

    static ResponseEntity<ProblemDetail> build(HttpStatus status, String code, String title, String detail, HttpServletRequest req) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, detail);
        pd.setTitle(title);
        pd.setType(URI.create("https://wakeline.invalid/problems/" + code.toLowerCase(Locale.ROOT).replace('_', '-')));
        pd.setInstance(URI.create(req.getRequestURI()));
        pd.setProperty("code", code);
        pd.setProperty("request_id", RequestIdFilter.current(req));
        return ResponseEntity.status(status).header("Content-Type", "application/problem+json").body(pd);
    }

    private static ResponseEntity<ProblemDetail> withRetryAfter(ResponseEntity<ProblemDetail> r, Integer retryAfterS) {
        if (retryAfterS == null) return r;
        return ResponseEntity.status(r.getStatusCode()).headers(r.getHeaders()).header(HttpHeaders.RETRY_AFTER, String.valueOf(retryAfterS)).body(r.getBody());
    }

    /** 로그용 한 줄: 예외 종류 + 가장 안쪽 원인 메시지(200자). 스택은 남기지 않는다. */
    static String brief(Throwable e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        String msg = String.valueOf(root.getMessage());
        if (msg.length() > 200) msg = msg.substring(0, 200) + "…";
        return e.getClass().getSimpleName() + (root == e ? "" : " ← " + root.getClass().getSimpleName()) + ": " + msg;
    }
}
