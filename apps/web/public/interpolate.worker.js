/* SkyWx 보간 워커(순수 JS, 번들러 무관). lib/interpolate.ts 와 같은 공식 — tests/worker-sync.test.ts 가 두 구현의 일치를 검사한다.
   250 ms 마다 dead reckoning 으로 렌더 상태를 만들어 메인 스레드로 보낸다. 서버 값이 오면 500 ms 완화(easing). */
(function () {
  "use strict";
  var R = 6371000, STALE_AFTER_S = 60, REMOVE_AFTER_S = 300;
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  function wrap180(lon) { return ((((lon + 180) % 360) + 360) % 360) - 180; }
  function deadReckon(lat, lon, trackDeg, gsKt, dtS) {
    var d = gsKt * 1852 * dtS / 3600, delta = d / R, th = rad(trackDeg), p1 = rad(lat), l1 = rad(lon);
    var p2 = Math.asin(Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(th));
    var l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(delta) * Math.cos(p1), Math.cos(delta) - Math.sin(p1) * Math.sin(p2));
    return [deg(p2), wrap180(deg(l2))];
  }
  function predict(s, nowMs) {
    var seenMs = s.seen_at ? Date.parse(s.seen_at) : nowMs;
    var dt = Math.max(0, (nowMs - seenMs) / 1000);
    var base = { hex: s.hex, lat: s.lat, lon: s.lon, alt_ft: s.alt_ft == null ? null : s.alt_ft, track_deg: s.track_deg == null ? null : s.track_deg,
      callsign: s.callsign == null ? null : s.callsign, estimated: false, stale: dt > STALE_AFTER_S,
      emergency: s.squawk === "7500" || s.squawk === "7600" || s.squawk === "7700", on_ground: !!s.on_ground, age_s: dt };
    if (s.on_ground || s.gs_kt == null || s.track_deg == null || s.gs_kt <= 0 || Math.abs(s.lat) > 85 || dt === 0) return base;
    var p = deadReckon(s.lat, s.lon, s.track_deg, s.gs_kt, Math.min(dt, REMOVE_AFTER_S));
    base.lat = p[0]; base.lon = p[1];
    base.alt_ft = s.alt_ft == null ? null : Math.round(s.alt_ft + ((s.vrate_fpm || 0) * dt) / 60);
    base.estimated = true;
    return base;
  }
  function ease(from, to, t) {
    var k = t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
    var dlon = to[1] - from[1];
    if (dlon > 180) dlon -= 360; if (dlon < -180) dlon += 360;
    return [from[0] + (to[0] - from[0]) * k, wrap180(from[1] + dlon * k)];
  }
  var states = new Map(), easing = new Map(), lastRender = new Map(), timer = null, tickMs = 250;
  // 뷰포트 컬링: 메인 스레드가 보내는 [w, s, e, n] + 여백 안의 항공기만 렌더 상태로 만든다(전세계 7,000+ 대 대응).
  var view = null;
  function inView(lat, lon) {
    if (!view) return true;
    if (lat < view[1] || lat > view[3]) return false;
    return view[0] <= view[2] ? lon >= view[0] && lon <= view[2] : lon >= view[0] || lon <= view[2];
  }
  // 대수가 많으면(저줌) 250 ms 보간이 화소 이하 이동이라 의미가 없다 → 1 s 로 낮춰 메인 스레드 setData 부하를 줄인다.
  function retime(n) {
    var want = n > 2000 ? 1000 : 250;
    if (want !== tickMs && timer) { clearInterval(timer); timer = setInterval(tick, want); }
    tickMs = want;
  }
  function tick() {
    var now = Date.now(), out = [];
    states.forEach(function (s) {
      if (!inView(s.lat, s.lon)) return;
      var r = predict(s, now);
      if (r.age_s > REMOVE_AFTER_S) return;
      var e = easing.get(s.hex);
      if (e) {
        var t = (now - e.at) / 500;
        if (t < 1) { var p = ease(e.from, [r.lat, r.lon], t); r.lat = p[0]; r.lon = p[1]; } else easing.delete(s.hex);
      }
      lastRender.set(s.hex, [r.lat, r.lon]);
      out.push(r);
    });
    lastRender.forEach(function (_v, h) { if (!states.has(h)) lastRender.delete(h); });
    retime(out.length);
    self.postMessage({ type: "render", at: now, states: out, total: states.size });
  }
  self.onmessage = function (ev) {
    var m = ev.data;
    if (m.type === "snapshot") { states.clear(); m.aircraft.forEach(function (a) { states.set(a.hex, a); }); }
    else if (m.type === "diff") {
      m.upsert.forEach(function (a) { var prev = lastRender.get(a.hex); if (prev) easing.set(a.hex, { from: prev, at: Date.now() }); states.set(a.hex, a); });
      m.remove.forEach(function (h) { states.delete(h); easing.delete(h); });
    }
    else if (m.type === "clear") { states.clear(); lastRender = new Map(); }
    else if (m.type === "viewport") {
      var b = m.bbox, padLon = (b[2] - b[0]) * 0.15, padLat = (b[3] - b[1]) * 0.15;
      view = [Math.max(-180, b[0] - padLon), Math.max(-90, b[1] - padLat), Math.min(180, b[2] + padLon), Math.min(90, b[3] + padLat)];
      if (b[2] - b[0] >= 300) view = null; // 사실상 전세계 → 컬링 없음
      tick();
    }
    else if (m.type === "start") { if (!timer) timer = setInterval(tick, tickMs); }
    else if (m.type === "stop") { if (timer) clearInterval(timer); timer = null; }
  };
  // 테스트에서 순수 함수를 꺼내 쓸 수 있게 노출(브라우저 워커에서는 무해)
  self.__skywx = { deadReckon: deadReckon, predict: predict, ease: ease, wrap180: wrap180 };
})();
