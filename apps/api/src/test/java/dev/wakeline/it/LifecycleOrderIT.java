package dev.wakeline.it;

import dev.wakeline.ingest.StreamAckFinalizer;
import dev.wakeline.platform.support.StreamPrerequisite;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.SmartLifecycle;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 스트림 소비 · 저장 · 마지막 ACK 의 기동 · 종료 순서가 의존 때문에 뒤집히지 않는다(QA-100 · QA-105). Spring 의 lifecycle 처리기는 빈을 시작하기 전에
 * 그 빈이 의존하는 빈을 phase 와 상관없이 먼저 시작하고, 멈추기 전에 그 빈에 의존하는 빈을 먼저 멈춘다. 예전에는 마지막 ACK(StreamAckFinalizer,
 * MAX-250)가 소비자(MAX-10)에 의존해 소비자가 저장기 · 인스턴스 가드보다 먼저 시작했고(선박 행 영구 손실), 마지막 ACK 가 저장기 flush 전에 나갔다.
 * 이제 순서는 의존이 정한다 — 소비자는 선행 구성 요소(StreamPrerequisite) 모두에 의존하고(먼저 시작 · 나중에 멈춤), 마지막 ACK 는 어떤 lifecycle 빈에도
 * 의존하지 않아 가장 낮은 phase 대로 저장기 flush 뒤에 멈춘다. 실제 컨텍스트의 의존 기록으로 지킨다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class LifecycleOrderIT extends IntegrationTest {
    @Autowired ConfigurableApplicationContext ctx;

    /** dev.wakeline 의 SmartLifecycle 빈(이름 → 빈). */
    Map<String, SmartLifecycle> ours() {
        Map<String, SmartLifecycle> out = new TreeMap<>();
        ctx.getBeansOfType(SmartLifecycle.class, false, false).forEach((name, bean) -> {
            if (AopUtils.getTargetClass(bean).getName().startsWith("dev.wakeline.")) out.put(name, bean);
        });
        return out;
    }

    @Test
    void theConsumerDependsOnEveryPrerequisiteSoItStartsAfterAndStopsBeforeThem() {
        ConfigurableListableBeanFactory bf = ctx.getBeanFactory();
        Map<String, StreamPrerequisite> prerequisites = ctx.getBeansOfType(StreamPrerequisite.class);
        assertThat(prerequisites.keySet()).containsExactlyInAnyOrder("trackWriter", "shipWriter", "orderedWriter", "singleInstanceGuard");
        assertThat(bf.getDependenciesForBean("streamConsumer")).as("the consumer starts after and stops before each of them")
                .contains(prerequisites.keySet().toArray(String[]::new));
        prerequisites.forEach((name, p) -> assertThat(p.readyForStream()).as(name + " ready in the running app").isTrue());
    }

    @Test
    void theFinalAckDependsOnNoLifecycleBeanAndStopsAfterEveryPrerequisite() {
        ConfigurableListableBeanFactory bf = ctx.getBeanFactory();
        Map<String, SmartLifecycle> beans = ours();
        assertThat(beans).containsKeys("streamConsumer", "streamAckFinalizer");
        List<String> lifecycleDeps = new ArrayList<>();
        for (String dep : bf.getDependenciesForBean("streamAckFinalizer")) if (beans.containsKey(dep)) lifecycleDeps.add(dep);
        assertThat(lifecycleDeps).as("a lifecycle dependency would start it early and stop the final ack before the writers flush").isEmpty();
        int finalAck = ctx.getBean(StreamAckFinalizer.class).getPhase();
        ctx.getBeansOfType(StreamPrerequisite.class).forEach((name, p) ->
                assertThat(p.getPhase()).as(name + " stops (flushes) before the final ack").isGreaterThan(finalAck));
    }
}
