# ADR-010 예측 알림은 관측 알림과 유형을 분리하고 항상 "추정" 으로 표시

`alert_event.kind ∈ {OBSERVED, PREDICTED}`. PREDICTED 는 10분 dead reckoning 직선 궤적이 폴리곤과 만나는 첫 시각(선분 교차 + 선형 보간)과 그때의 고도(수직속도 반영)로 판정하며 `estimated=true`. 선회 중(최근 3회 트랙 변화 > 15°)·60 kt 미만·지상은 예측하지 않는다. 같은 (hex, sigmet) 에 대해 이벤트는 한 번, ETA 는 30 s 이상 바뀔 때만 갱신, 사라지면 PREDICTION_CLEARED, 관측 진입이 확정되면 예측은 정리된다. 화면은 점선·보라색 "추정" 배지로 구분한다.
