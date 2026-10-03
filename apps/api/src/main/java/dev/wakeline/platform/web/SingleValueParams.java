package dev.wakeline.platform.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.MethodParameter;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.Collection;
import java.util.Map;

/**
 * 하나만 받는 요청 파라미터가 두 번 이상 오면 400 BAD_REQUEST(계약 v5 §G43 — QA 2026-10 기능 개선 제안 4). 예전에는 Spring 이 너그럽게 읽었다: 형이 있으면
 * 첫 값(from=a&amp;from=b → a), 글자면 쉼표로 이어 붙였다(hazard=TS&amp;hazard=ICE → "TS,ICE" — 일치 0건). 어느 값을 뜻했는지 서버가 고르지 않는다.
 * 여러 값을 받는 파라미터(List · 배열 — 운영 로그의 level · service)는 그대로. 컨트롤러가 선언한 {@code @RequestParam} 만 본다(선언하지 않은 이름은 쓰지
 * 않으므로 상관없다). 여기서 던진 {@link Problem} 은 {@link ProblemAdvice} 가 problem+json 으로 답한다.
 */
public final class SingleValueParams implements HandlerInterceptor {
    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        if (!(handler instanceof HandlerMethod hm)) return true;
        for (MethodParameter p : hm.getMethodParameters()) {
            RequestParam rp = p.getParameterAnnotation(RequestParam.class);
            if (rp == null) continue;
            Class<?> t = p.getParameterType();
            if (Collection.class.isAssignableFrom(t) || t.isArray() || Map.class.isAssignableFrom(t)) continue;
            String name = !rp.name().isEmpty() ? rp.name() : p.getParameterName();
            if (name == null) continue;
            String[] values = req.getParameterValues(name);
            if (values != null && values.length > 1) throw Problem.badRequest("BAD_REQUEST", "parameter " + name + " must be given once");
        }
        return true;
    }
}
