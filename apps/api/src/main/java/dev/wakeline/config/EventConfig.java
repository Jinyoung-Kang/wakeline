package dev.wakeline.config;

import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.event.SimpleApplicationEventMulticaster;
import org.springframework.context.support.AbstractApplicationContext;

/**
 * 애플리케이션 이벤트 멀티캐스터 교체(이름 applicationEventMulticaster — 컨텍스트가 이 이름의 빈을 찾아 쓴다).
 * 동기 전달은 그대로다: 스트림 소비 스레드가 리스너를 순서대로 부르고, 리스너 예외만 파이프라인 이벤트에 한해 격리한다.
 */
@Configuration(proxyBeanMethods = false)
public class EventConfig {

    @Bean(name = AbstractApplicationContext.APPLICATION_EVENT_MULTICASTER_BEAN_NAME)
    static SimpleApplicationEventMulticaster applicationEventMulticaster(BeanFactory beanFactory, ObjectProvider<MeterRegistry> meters) {
        // 멀티캐스터는 컨텍스트 초기에 만들어진다 — 지표 레지스트리는 실제로 필요할 때(첫 예외) 가져온다
        return new PipelineEventMulticaster(beanFactory, meters::getIfAvailable);
    }
}
