package dev.skywx.engine;

import dev.skywx.domain.Alert;

import java.util.List;

public final class EngineEvents {
    private EngineEvents() {}

    /** 한 주기의 알림 이벤트 묶음(WS 팬아웃·DB 저장). */
    public record AlertsChanged(List<AlertStateMachine.Event> events) {}
}
