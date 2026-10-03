package dev.wakeline.platform.web;

import org.springframework.core.convert.ConversionService;
import org.springframework.web.bind.WebDataBinder;

import java.beans.PropertyEditorSupport;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.function.Function;

/**
 * 시각(Instant) · 날짜(LocalDate) 요청 파라미터가 받을 수 있는 범위(QA-207 · QA-001 · QA-201 · QA-202 · QA-208) — 모든 컨트롤러의 {@code @RequestParam} ·
 * {@code @PathVariable} 에 같은 규칙. 범위 밖이면 400 BAD_REQUEST(problem+json — {@link ProblemAdvice})이고 저장소에 닿지 않는다.
 * <p>
 * 예전에는 Java 가 받는 범위(연도 ±999,999,999)를 그대로 받아, 경로마다 다른 방식으로 깨졌다: 기원전 4713 년 앞의 날짜는 pgjdbc 가 '-infinity' 로 보내
 * {@code generate_series} 가 끝나지 않는 계열을 3 s 한도까지 정렬했고(DB CPU 100 % · 임시 파일 0.5–0.8 GB, 503 '재시도'), 운영 재집계는 day = -infinity
 * 행을 썼다. PostgreSQL 범위(timestamptz 294276 AD · date 5874897 AD)를 넘는 값은 DB 오류, Instant 끝값은 컨트롤러의 계산(end.minus · toEpochMilli ·
 * plusDays)이 넘쳐 500 + ERROR 스택이었다.
 * <p>
 * 범위는 자료 모델에서 고른다:
 * <ul>
 *   <li>하한 {@link #MIN} = 1970-01-01T00:00:00Z(날짜는 1970-01-01): 저장하는 모든 시각은 수집 시스템이 받은 관측 · 실행의 시각이다(수집기 · 스트림 id ·
 *       파티션 모두 유닉스 시각 — 그 앞의 행은 있을 수 없다). 그래서 1970 앞을 묻는 요청은 답이 늘 비어 있고, 거절해도 잃는 것이 없다.</li>
 *   <li>상한 {@link #MAX} = 9999-12-31T23:59:59.999999999Z(날짜는 9999-12-31): ISO 8601 의 네 자리 연도 끝 — 브라우저의 {@code toISOString()} 이 늘
 *       만드는 형식이다. 미래를 묻는 요청(창의 끝이 조금 뒤 · 오늘까지의 통계)은 정상이라 '지금' 이 아니라 형식의 끝으로 묶는다.</li>
 * </ul>
 * 이 범위가 모든 경로에 안전한 까닭: PostgreSQL timestamptz · date 와 Java 의 계산(경로마다 기본 창 2 h · 24 h · 7일을 빼고, 범위 검사에서 92일을 더하고,
 * toEpochMilli · KST 날짜 변환을 한다)이 양 끝에서도 넘치지 않는다. 각 경로의 창 규칙(항적 24 h · AIS 공백 31일 · 알림 이력 30일 · 통계 92일 · 재생 31일과
 * 미래 60 s · 재집계는 오늘 KST 이전)은 그대로 뒤에서 검사한다 — 재생의 보존(31일)과 통계의 날 범위(92일)는 이 범위보다 늘 좁다.
 * <p>
 * 해석: 시각은 바인더의 변환 서비스(ISO 순간 등 — 로캘과 상관없음)가 읽고, 날짜는 ISO(yyyy-MM-dd)만 읽는다(계약 v5 §G43 — 예전에는 로캘의 짧은 형식도).
 * 그 값을 범위로 거른다. 같은 이름의 파라미터가 여럿이면 400 이다(SingleValueParams — 예전에는 첫 값).
 */
public final class TimeParams {
    private TimeParams() {}

    public static final Instant MIN = Instant.EPOCH;
    public static final Instant MAX = Instant.parse("9999-12-31T23:59:59.999999999Z");
    public static final LocalDate MIN_DAY = LocalDate.of(1970, 1, 1);
    public static final LocalDate MAX_DAY = LocalDate.of(9999, 12, 31);

    /** 범위 밖 값. 바인더가 형 변환 실패(MethodArgumentTypeMismatchException)로 감싸 {@link ProblemAdvice} 가 400 으로 답한다. */
    public static final class OutOfRange extends IllegalArgumentException {
        OutOfRange(String detail) { super(detail); }
    }

    public static Instant checked(Instant v) {
        if (v != null && (v.isBefore(MIN) || v.isAfter(MAX))) throw new OutOfRange("out of the supported range " + MIN + " – " + MAX);
        return v;
    }

    public static LocalDate checked(LocalDate v) {
        if (v != null && (v.isBefore(MIN_DAY) || v.isAfter(MAX_DAY))) throw new OutOfRange("out of the supported range " + MIN_DAY + " – " + MAX_DAY);
        return v;
    }

    /** 요청 파라미터 바인더에 두 형의 편집기를 단다(ProblemAdvice 의 @InitBinder — 모든 컨트롤러). */
    public static void register(WebDataBinder binder) {
        ConversionService cs = binder.getConversionService();
        binder.registerCustomEditor(Instant.class, new Bounded<>(Instant.class, cs, Instant::parse, TimeParams::checked));
        // 날짜는 ISO(yyyy-MM-dd)만 — 변환 서비스는 로캘의 짧은 형식도 읽었고 로캘은 요청의 Accept-Language(없으면 JVM 기본)라 같은 글자(02/10/26)가 클라이언트마다
        // 다른 날(en-US 2월 10일 · en-GB 26년 · ko-KR 400)이 됐다(계약 v5 §G43). 시각(Instant)은 로캘과 상관없는 형식만 읽으므로 그대로.
        binder.registerCustomEditor(LocalDate.class, new Bounded<>(LocalDate.class, null, s -> LocalDate.parse(s.strip()), TimeParams::checked));
    }

    /** 변환 서비스로 읽고(없으면 ISO) 범위로 거르는 편집기. */
    static final class Bounded<T> extends PropertyEditorSupport {
        private final Class<T> type;
        private final ConversionService cs;
        private final Function<String, T> iso;
        private final Function<T, T> check;

        Bounded(Class<T> type, ConversionService cs, Function<String, T> iso, Function<T, T> check) {
            this.type = type;
            this.cs = cs;
            this.iso = iso;
            this.check = check;
        }

        @Override
        public void setAsText(String text) {
            if (text == null || text.isBlank()) {
                setValue(null);
                return;
            }
            T v;
            try {
                v = cs != null && cs.canConvert(String.class, type) ? cs.convert(text, type) : iso.apply(text);
            } catch (DateTimeException e) { // ISO 해석 실패도 형 변환 실패(400)로
                throw new IllegalArgumentException(e.getMessage(), e);
            }
            super.setValue(check.apply(v));
        }

        /**
         * 같은 이름의 파라미터가 여럿이면(String[]) 전처럼 첫 값을 쓴다(변환 서비스의 배열 → 값 규칙과 같다). 여기서 던진 예외는 바인더가 삼키고 값들을
         * 쉼표로 이은 글자로 {@link #setAsText} 를 다시 부른다 — 그 글자는 형식이 틀려 역시 400 이다.
         */
        @Override
        public void setValue(Object value) {
            if (value instanceof String[] arr) {
                setAsText(arr.length == 0 ? null : arr[0]);
                return;
            }
            super.setValue(type.isInstance(value) ? check.apply(type.cast(value)) : value);
        }
    }
}
