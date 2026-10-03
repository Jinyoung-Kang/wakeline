package dev.wakeline.platform.web;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** /api 요청의 공통 입력 규칙 중 핸들러를 알아야 하는 것(하나만 받는 파라미터 — {@link SingleValueParams}). 값의 형식 규칙은 {@link ProblemAdvice} 의 바인더. */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Configuration
public class ApiWebConfig implements WebMvcConfigurer {
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new SingleValueParams()).addPathPatterns("/api/**");
    }
}
