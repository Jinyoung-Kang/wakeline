/* Wakeline 보간 워커(순수 JS, 번들러 무관). lib/interpolate.ts 와 같은 공식·규칙 — tests/worker-sync.test.ts 가 두 구현의 일치를 검사한다.
   - dead reckoning 으로 렌더 상태를 만들어 메인 스레드로 보낸다. 서버 값이 오면 500 ms 완화(easing).
   - 경과 시간으로 항공기를 지우지 않는다(FR-19). 삭제는 서버의 remove·스냅샷만. 외삽은 60 s(opensky 180 s) 상한에서 멈추고 stale.
   - 바뀐 것이 없으면(데이터·뷰포트·위치·stale 수) postMessage 하지 않는다. 틱 간격은 줌에 따라 0.5 px 이동 시간(250 ms – 4 s).
   - 경과·stale·외삽은 서버 기준 시각(브라우저 시각 + 메인 스레드가 보낸 "clock" 오프셋)으로 계산한다 — 카드·툴팁·ETA 와 같은 기준(WS-3).
     easing(화면 완화)은 브라우저 시각끼리의 차이라 오프셋과 무관하다. */
(function () {
  "use strict";
  var R = 6371000, STALE_AFTER_S = 60, STALE_AFTER_OPENSKY_S = 300, EXTRAPOLATE_CAP_S = 60, EXTRAPOLATE_CAP_OPENSKY_S = 180;
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  function wrap180(lon) { return ((((lon + 180) % 360) + 360) % 360) - 180; }
  function deadReckon(lat, lon, trackDeg, gsKt, dtS) {
    var d = gsKt * 1852 * dtS / 3600, delta = d / R, th = rad(trackDeg), p1 = rad(lat), l1 = rad(lon);
    var p2 = Math.asin(Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(th));
    var l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(delta) * Math.cos(p1), Math.cos(delta) - Math.sin(p1) * Math.sin(p2));
    return [deg(p2), wrap180(deg(l2))];
  }
  function thresholds(provider) {
    return provider === "opensky" ? { staleAfterS: STALE_AFTER_OPENSKY_S, capS: EXTRAPOLATE_CAP_OPENSKY_S } : { staleAfterS: STALE_AFTER_S, capS: EXTRAPOLATE_CAP_S };
  }
  function seenAtMs(v) {
    if (typeof v === "number") return isFinite(v) ? v * 1000 : null;
    if (typeof v === "string" && v.length > 0) { var t = Date.parse(v); return isNaN(t) ? null : t; }
    return null;
  }
  function predict(s, nowMs) {
    var seen = seenAtMs(s.seen_at);
    var age = seen == null ? null : Math.max(0, (nowMs - seen) / 1000);
    var th = thresholds(s.provider);
    var base = { hex: s.hex, lat: s.lat, lon: s.lon, alt_ft: s.alt_ft == null ? null : s.alt_ft, track_deg: s.track_deg == null ? null : s.track_deg,
      callsign: s.callsign == null ? null : s.callsign, estimated: false, stale: age != null && age > th.staleAfterS, capped: false, age_unknown: age == null,
      emergency: s.squawk === "7500" || s.squawk === "7600" || s.squawk === "7700", on_ground: s.on_ground == null ? null : s.on_ground === true, age_s: age };
    if (age == null || age === 0 || s.on_ground === true || s.gs_kt == null || s.track_deg == null || s.gs_kt <= 0 || Math.abs(s.lat) > 85) return base;
    var capped = age > th.capS;
    var dt = capped ? th.capS : age;
    var p = deadReckon(s.lat, s.lon, s.track_deg, s.gs_kt, dt);
    base.lat = p[0]; base.lon = p[1];
    base.alt_ft = s.alt_ft == null ? null : s.vrate_fpm == null ? s.alt_ft : Math.round(s.alt_ft + (s.vrate_fpm * dt) / 60);
    base.estimated = true;
    base.capped = capped;
    base.stale = base.stale || capped;
    return base;
  }
  function ease(from, to, t) {
    var k = t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
    var dlon = to[1] - from[1];
    if (dlon > 180) dlon -= 360; if (dlon < -180) dlon += 360;
    return [from[0] + (to[0] - from[0]) * k, wrap180(from[1] + dlon * k)];
  }
  function tickIntervalMs(zoom, midLat, n) {
    var want = 250;
    if (zoom != null && isFinite(zoom)) {
      var halfPxDeg = 180 / (512 * Math.pow(2, zoom));
      var cosLat = Math.max(0.2, Math.cos(rad(midLat == null ? 0 : midLat)));
      var degPerS = 500 / 3600 / 60 / cosLat;
      want = Math.round((1000 * halfPxDeg) / degPerS);
    }
    if (n > 2000) want = Math.max(want, 1000);
    return Math.min(4000, Math.max(250, want));
  }

  var states = new Map(), easing = new Map(), posted = new Map();
  var timer = null, running = false, tickMs = 250, dirty = true, lastStaleN = -1;
  // 뷰포트 컬링: 메인 스레드가 보내는 [w, s, e, n] + 여백 안의 항공기만 렌더 상태로 만든다(전세계 7,000+ 대 대응).
  var view = null, zoom = null, midLat = null;
  // 서버 − 브라우저 시계 오프셋(ms). 모르면 0(브라우저 시계 그대로).
  var clockOffset = 0;
  function inView(lat, lon) {
    if (!view) return true;
    if (lat < view[1] || lat > view[3]) return false;
    return view[0] <= view[2] ? lon >= view[0] && lon <= view[2] : lon >= view[0] || lon <= view[2];
  }
  function tick() {
    var now = Date.now(), serverNow = now + clockOffset, out = [], changed = dirty, staleN = 0;
    states.forEach(function (s) {
      if (!inView(s.lat, s.lon)) return;
      var r = predict(s, serverNow);
      var e = easing.get(s.hex);
      if (e) {
        var t = (now - e.at) / 500;
        if (t < 1) { var p = ease(e.from, [r.lat, r.lon], t); r.lat = p[0]; r.lon = p[1]; } else easing.delete(s.hex);
      }
      var prev = posted.get(s.hex);
      if (!prev || prev[0] !== r.lat || prev[1] !== r.lon) changed = true;
      if (r.stale) staleN++;
      out.push(r);
    });
    if (staleN !== lastStaleN || out.length !== posted.size) changed = true;
    tickMs = tickIntervalMs(zoom, midLat, out.length);
    if (!changed) return false;
    // 마지막으로 보낸 위치 — 다음 틱의 변경 감지와 diff 의 easing 시작점
    posted = new Map();
    for (var i = 0; i < out.length; i++) posted.set(out[i].hex, [out[i].lat, out[i].lon]);
    dirty = false;
    lastStaleN = staleN;
    self.postMessage({ type: "render", at: now, states: out, total: states.size });
    return true;
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!running) return;
    timer = setTimeout(function () { timer = null; tick(); schedule(); }, easing.size > 0 ? Math.min(tickMs, 250) : tickMs);
  }
  function kick() { dirty = true; if (running) { tick(); schedule(); } }
  self.onmessage = function (ev) {
    var m = ev.data;
    if (m.type === "snapshot") { states.clear(); easing.clear(); m.aircraft.forEach(function (a) { states.set(a.hex, a); }); kick(); }
    else if (m.type === "diff") {
      var at = Date.now();
      m.upsert.forEach(function (a) { var prev = posted.get(a.hex); if (prev) easing.set(a.hex, { from: prev, at: at }); states.set(a.hex, a); });
      m.remove.forEach(function (h) { states.delete(h); easing.delete(h); });
      kick();
    }
    else if (m.type === "clear") { states.clear(); easing.clear(); posted = new Map(); kick(); }
    else if (m.type === "viewport") {
      var b = m.bbox, padLon = (b[2] - b[0]) * 0.15, padLat = (b[3] - b[1]) * 0.15;
      view = [Math.max(-180, b[0] - padLon), Math.max(-90, b[1] - padLat), Math.min(180, b[2] + padLon), Math.min(90, b[3] + padLat)];
      if (b[2] - b[0] >= 300) view = null; // 사실상 전세계 → 컬링 없음
      zoom = typeof m.zoom === "number" ? m.zoom : null;
      midLat = (b[1] + b[3]) / 2;
      kick();
    }
    else if (m.type === "invalidate") kick(); // 선택 변경 등 메인 스레드가 다시 그리기를 원할 때
    else if (m.type === "clock") { if (typeof m.offsetMs === "number" && isFinite(m.offsetMs)) { clockOffset = m.offsetMs; kick(); } }
    else if (m.type === "start") { running = true; kick(); }
    else if (m.type === "stop") { running = false; schedule(); }
  };
  // 테스트에서 순수 함수·틱을 꺼내 쓸 수 있게 노출(브라우저 워커에서는 무해)
  self.__wakeline = { deadReckon: deadReckon, predict: predict, ease: ease, wrap180: wrap180, seenAtMs: seenAtMs, thresholds: thresholds, tickIntervalMs: tickIntervalMs, tick: tick,
    clockOffset: function () { return clockOffset; } };
})();
