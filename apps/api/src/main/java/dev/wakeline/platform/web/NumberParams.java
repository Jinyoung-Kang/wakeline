package dev.wakeline.platform.web;

import org.springframework.web.bind.WebDataBinder;

import java.beans.PropertyEditorSupport;
import java.util.regex.Pattern;

/**
 * 정수 요청 파라미터(int · Integer · long · Long)는 ASCII 10진 숫자만(앞에 '-' 하나, 앞뒤 공백은 지운다) — 계약 v5 §G43 · QA 2026-10 기능 개선 제안 4.
 * 예전에는 Spring 의 수 변환이 0x10 · #10(16진) · +5 · 전각 숫자(５ — Character.digit 이 받는다)도 읽었다(OpenAPI 의 integer 보다 넓다). 밖이면 형 변환
 * 실패(400 BAD_REQUEST "invalid parameter: …" — {@link ProblemAdvice}). 범위 규칙(끝값으로 자르기 · 400)은 그대로 각 경로가 정한다.
 */
public final class NumberParams {
    private NumberParams() {}

    static final Pattern ASCII_INT = Pattern.compile("^-?[0-9]{1,19}$");

    /** 요청 파라미터 바인더에 정수 편집기를 단다(ProblemAdvice 의 @InitBinder — 모든 컨트롤러). */
    public static void register(WebDataBinder binder) {
        binder.registerCustomEditor(int.class, new Strict(false, true));
        binder.registerCustomEditor(Integer.class, new Strict(false, false));
        binder.registerCustomEditor(long.class, new Strict(true, true));
        binder.registerCustomEditor(Long.class, new Strict(true, false));
    }

    static final class Strict extends PropertyEditorSupport {
        private final boolean wide;
        private final boolean primitive;

        Strict(boolean wide, boolean primitive) {
            this.wide = wide;
            this.primitive = primitive;
        }

        @Override
        public void setAsText(String text) {
            String t = text == null ? "" : text.strip();
            if (t.isEmpty()) {
                if (primitive) throw new IllegalArgumentException("a number is required");
                setValue(null);
                return;
            }
            if (!ASCII_INT.matcher(t).matches()) throw new IllegalArgumentException("must be a base-10 integer of ASCII digits");
            long v;
            try {
                v = Long.parseLong(t);
            } catch (NumberFormatException e) {
                throw new IllegalArgumentException("out of range", e);
            }
            if (!wide && (v < Integer.MIN_VALUE || v > Integer.MAX_VALUE)) throw new IllegalArgumentException("out of range");
            setValue(wide ? (Object) v : (Object) (int) v);
        }
    }
}
