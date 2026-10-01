package dev.wakeline.engine;

import dev.wakeline.domain.Alert;
import dev.wakeline.platform.support.PipelineEvent;

import java.util.List;

public final class EngineEvents {
    private EngineEvents() {}

    /** 한 주기의 알림 이벤트 묶음(WS 팬아웃·DB 저장). */
    public record AlertsChanged(List<AlertStateMachine.Event> events) implements PipelineEvent {}
}
