#!/usr/bin/env python3
"""QA 값 정확성 점검(QA 2026-10 §3.2 — fixture 응답이 원본과 맞는가). 표준 라이브러리만, 격리 스택(8701 · 8702)만.

- 항공기: fixtures/adsb_lol_region.json 과 /aircraft?detail=full 의 단위(ft · kt · deg · ft/min) · 값 · '없는 값은 키 없음'.
- 선박: fixtures/ais_east_asia_90s.jsonl 의 '값 없음' 표기(선수방위 511 · 침로 360 · ETA 월 0 · 일 0 · 시 24 · 분 60)가 API 에서 빠지는가,
  SOG(kt) · 크기(m) · 흘수(m)가 보고값 그대로인가.
- 시각: 공개 응답의 ISO 시각 글자가 UTC('Z')인가(이름이 *_kst 인 필드 · 기상청 tm 은 예외 — 계약 v5 §G20).
- /alerts/history 쪽 넘김(limit 7 로 끝까지): 겹침 · 빠짐 없음, id 내림차순, 한 번에 받은 목록과 같은가.
- /aircraft/search · /ships/search: 상한 · 접두 일치 · 정렬(계약 v5 §B1 — 정확 일치 → 최근 보고 → MMSI) · count.
- /replay: 보존 경계(31일) 앞뒤 · source · radar(2시간 안만).
- /stats/*: day_zone · days 가 [from, to] 의 KST 날짜를 빠짐없이 · 오늘은 aggregated=false.

    python3 tools/qa/value_checks.py     # → docs/qa/2026-10/evidence/functional/values-<UTC>.md, 어긋남이 있으면 종료 코드 1
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
import sys
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fuzz_api import Client, REPO, OUT_DIR  # noqa: E402

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$")
KST_KEYS = {"reg_dt_kst"}

results = []


def check(area, name, ok, detail=""):
    results.append({"area": area, "name": name, "ok": bool(ok), "detail": detail})
    print(f"{'ok  ' if ok else 'FAIL'} {area} · {name} {detail}", file=sys.stderr)


def get(c: Client, path):
    r = c.send("GET", path)
    try:
        return r["status"], json.loads(r["body"] or b"null"), r["headers"]
    except ValueError:
        return r["status"], None, r["headers"]


def walk_times(node, path="", out=None):
    out = [] if out is None else out
    if isinstance(node, dict):
        for k, v in node.items():
            walk_times(v, f"{path}.{k}", out)
    elif isinstance(node, list):
        for i, v in enumerate(node[:50]):
            walk_times(v, f"{path}[{i}]", out)
    elif isinstance(node, str) and ISO.match(node):
        out.append((path, node))
    return out


# ------------------------------------------------------------------ 항공기

def aircraft(c):
    fx = {a["hex"]: a for a in json.load(open(os.path.join(REPO, "fixtures", "adsb_lol_region.json")))["ac"]}
    st, body, _ = get(c, "/api/v1/aircraft?bbox=115,28,140,46&detail=full")
    check("aircraft", "응답 200", st == 200, str(st))
    if st != 200:
        return
    feats = body["features"]
    matched, mism, invented = 0, [], []
    for f in feats:
        p = f["properties"]
        a = fx.get(p["hex"])
        if not a:
            continue
        matched += 1
        pairs = [("alt_ft", "alt_baro"), ("gs_kt", "gs"), ("vrate_fpm", "baro_rate"), ("squawk", "squawk")]
        for k, fk in pairs:
            if fk not in a or a.get(fk) == "ground":
                if k in p and p[k] is not None and not (k == "alt_ft" and a.get(fk) == "ground"):
                    invented.append(f"{p['hex']}.{k}={p[k]} (fixture 에 {fk} 없음)")
                continue
            want = a[fk]
            got = p.get(k)
            if isinstance(want, (int, float)) and isinstance(got, (int, float)):
                if abs(float(want) - float(got)) > 0.051:
                    mism.append(f"{p['hex']}.{k}: fixture {fk}={want}, api {got}")
            elif str(want).strip() != str(got).strip():
                mism.append(f"{p['hex']}.{k}: fixture {fk}={want!r}, api {got!r}")
        # 방위: track 이 있으면 그것, 없으면 calc_track
        want_trk = a.get("track", a.get("calc_track"))
        if want_trk is not None and p.get("track_deg") is not None and abs(float(want_trk) - float(p["track_deg"])) > 0.051:
            mism.append(f"{p['hex']}.track_deg: fixture {want_trk}, api {p['track_deg']}")
        if want_trk is None and p.get("track_deg") is not None:
            invented.append(f"{p['hex']}.track_deg={p['track_deg']} (fixture 에 track 없음)")
        if a.get("flight") is not None and (p.get("callsign") or "").strip() != a["flight"].strip():
            mism.append(f"{p['hex']}.callsign: fixture {a['flight']!r}, api {p.get('callsign')!r}")
        if a.get("alt_baro") == "ground" and p.get("on_ground") is not True:
            mism.append(f"{p['hex']}.on_ground: fixture alt_baro=ground, api {p.get('on_ground')}")
        if "r" in a and p.get("registration") not in (None, a["r"]):
            mism.append(f"{p['hex']}.registration: fixture {a['r']}, api {p.get('registration')}")
    check("aircraft", f"fixture 와 같은 hex {matched}대", matched > 50, f"API {len(feats)}대")
    check("aircraft", "단위 · 값이 fixture 그대로(ft · kt · deg · ft/min · squawk · 호출부호)", not mism, "; ".join(mism[:8]))
    check("aircraft", "fixture 에 없는 값을 지어내지 않음", not invented, "; ".join(invented[:8]))


# ------------------------------------------------------------------ 선박

def ships(c):
    pos = collections.defaultdict(list)
    stat = collections.defaultdict(list)
    for line in open(os.path.join(REPO, "fixtures", "ais_east_asia_90s.jsonl")):
        m = json.loads(line)
        t = m["MessageType"]
        body = m["Message"][t]
        mmsi = str(body.get("UserID") or m["MetaData"]["MMSI"])
        if "Position" in t:
            pos[mmsi].append(body)
        if t == "ShipStaticData":
            stat[mmsi].append(body)
    live = {}
    for bb in ("100,0,150,45", "110,20,160,50"):
        st, body, _ = get(c, "/api/v1/ships?bbox=" + bb)
        if st == 200:
            for f in body["features"]:
                live[f["id"]] = f["properties"]
    check("ships", f"실시간 선박 {len(live)}척", len(live) > 100)
    bad = []
    hd_na = [m for m, rs in pos.items() if rs and all(r.get("TrueHeading") == 511 for r in rs) and m in live]
    for m in hd_na:
        if "heading_deg" in live[m]:
            bad.append(f"{m} heading 511 → api heading_deg={live[m]['heading_deg']}")
    cog_na = [m for m, rs in pos.items() if rs and all(r.get("Cog") == 360 for r in rs) and m in live]
    for m in cog_na:
        if "cog_deg" in live[m]:
            bad.append(f"{m} cog 360 → api cog_deg={live[m]['cog_deg']}")
    check("ships", f"선수방위 511 · 침로 360 → 키 없음({len(hd_na)} · {len(cog_na)}척)", not bad and hd_na, "; ".join(bad[:6]))
    sog_bad = []
    for m, rs in pos.items():
        if m in live and "sog_kn" in live[m]:
            vals = {round(float(r["Sog"]), 1) for r in rs if r.get("Sog") is not None and r.get("Sog") != 102.3}
            if vals and round(float(live[m]["sog_kn"]), 1) not in vals:
                sog_bad.append(f"{m} api {live[m]['sog_kn']} ∉ fixture {sorted(vals)[:4]}")
            hds = {r["TrueHeading"] for r in rs if r.get("TrueHeading") not in (None, 511)}
            if "heading_deg" in live[m] and hds and live[m]["heading_deg"] not in hds:
                sog_bad.append(f"{m} heading api {live[m]['heading_deg']} ∉ fixture {sorted(hds)[:4]}")
    check("ships", "SOG(kt) · 선수방위(deg)가 보고값 중 하나", not sog_bad, "; ".join(sog_bad[:6]))
    # 정적 정보 · ETA '값 없음'
    eta_bad, dim_bad, checked = [], [], 0
    for m, rs in list(stat.items())[:25]:
        st, body, _ = get(c, f"/api/v1/ships/{m}")
        if st != 200 or not body.get("static"):
            continue
        checked += 1
        s = body["static"]
        last = rs[-1]
        eta = last.get("Eta") or {}
        for k, fk, lo, hi in (("eta_month", "Month", 1, 12), ("eta_day", "Day", 1, 31), ("eta_hour", "Hour", 0, 23), ("eta_minute", "Minute", 0, 59)):
            v = eta.get(fk)
            na = v is None or not (lo <= v <= hi)
            if all(not (lo <= ((r.get("Eta") or {}).get(fk) if (r.get("Eta") or {}).get(fk) is not None else -1) <= hi) for r in rs) and k in s:
                eta_bad.append(f"{m}.{k}={s[k]} (fixture {fk} 늘 값 없음 {v})")
            if not na and all((r.get("Eta") or {}).get(fk) == v for r in rs) and s.get(k) != v:
                eta_bad.append(f"{m}.{k}: fixture {v}, api {s.get(k)}")
        d = last.get("Dimension") or {}
        for k, fk in (("dim_a", "A"), ("dim_b", "B"), ("dim_c", "C"), ("dim_d", "D")):
            if all((r.get("Dimension") or {}).get(fk) == d.get(fk) for r in rs) and d.get(fk) and s.get(k) not in (None, d.get(fk)):
                dim_bad.append(f"{m}.{k}: fixture {d.get(fk)} m, api {s.get(k)}")
        dr = last.get("MaximumStaticDraught")
        if dr and all(r.get("MaximumStaticDraught") == dr for r in rs) and s.get("draught_m") is not None and abs(s["draught_m"] - dr) > 0.051:
            dim_bad.append(f"{m}.draught_m: fixture {dr}, api {s['draught_m']}")
        if last.get("Name") and s.get("name") and s["name"] != last["Name"].strip().rstrip("@").strip():
            dim_bad.append(f"{m}.name: fixture {last['Name']!r}, api {s['name']!r}")
    check("ships", f"ETA '값 없음'(월 0 · 일 0 · 시 24 · 분 60) → 키 없음, 값은 그대로({checked}척)", not eta_bad and checked, "; ".join(eta_bad[:6]))
    check("ships", "크기(m) · 흘수(m) · 선명이 보고값 그대로", not dim_bad, "; ".join(dim_bad[:6]))


# ------------------------------------------------------------------ 시각

def times(c):
    now = dt.datetime.now(dt.timezone.utc)
    paths = ["/api/v1/status", "/api/v1/aircraft?bbox=124,33,132,39", "/api/v1/ships?bbox=110,20,150,45", "/api/v1/sigmets", "/api/v1/alerts",
             "/api/v1/alerts/history?limit=20", "/api/v1/radar/frames", "/api/v1/radar/kr", "/api/v1/airports", "/api/v1/airports/RKSI/wx",
             "/api/v1/ships/coverage", "/api/v1/traffic/grid", "/api/v1/ais/gaps", "/api/v1/stats/alerts", "/api/v1/stats/traffic",
             "/api/v1/replay?at=" + quote((now - dt.timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")) + "&bbox=124,33,132,39",
             "/api/v1/aircraft/71be01", "/api/v1/ships/432952000", "/api/v1/ships/432952000/track"]
    bad, n = [], 0
    for p in paths:
        st, body, _ = get(c, p)
        if st != 200 or body is None:
            continue
        for path, v in walk_times(body):
            n += 1
            key = path.rsplit(".", 1)[-1].split("[")[0]
            if key in KST_KEYS:
                if not v.endswith("+09:00"):
                    bad.append(f"{p} {path}={v} (KST 필드인데 +09:00 아님)")
            elif not v.endswith("Z"):
                bad.append(f"{p} {path}={v}")
    check("time", f"공개 응답의 ISO 시각 {n}개가 UTC 'Z'", not bad and n > 50, "; ".join(bad[:8]))


# ------------------------------------------------------------------ 알림 이력 쪽 넘김

def alert_paging(c):
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    frm, to = (now - dt.timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ"), now.strftime("%Y-%m-%dT%H:%M:%SZ")

    def walk(limit, max_pages):
        ids, cur, pages, items = [], None, 0, []
        while pages < max_pages:
            q = f"/api/v1/alerts/history?from={frm}&to={to}&limit={limit}" + (f"&cursor={cur}" if cur is not None else "")
            st, page, _ = get(c, q)
            if st != 200:
                return None, pages, f"{st} {q}"
            pages += 1
            if len(page["items"]) > limit:
                return None, pages, f"limit {limit} 넘김 {len(page['items'])}"
            ids += [x["id"] for x in page["items"]]
            items += page["items"]
            cur = page.get("next_cursor")
            if cur is None:
                return (ids, items), pages, ""
        return (ids, items), pages, "쪽 상한"

    big, pb, eb = walk(200, 20)
    small, ps, es = walk(25, 200)
    if big is None or small is None or eb or es:
        check("alerts.history", "쪽 넘김 끝까지", False, f"{eb} {es}")
        return
    ids_big, items = big
    ids_small, _ = small
    dups = [i for i, n in collections.Counter(ids_small).items() if n > 1]
    check("alerts.history", f"limit 25 로 쪽 {ps}개 · 항목 {len(ids_small)} — 겹침 없음", not dups, str(dups[:5]))
    check("alerts.history", "id 내림차순", ids_small == sorted(ids_small, reverse=True) and ids_big == sorted(ids_big, reverse=True))
    missing = sorted(set(ids_big) - set(ids_small))[:5]
    extra = sorted(set(ids_small) - set(ids_big))[:5]
    check("alerts.history", f"limit 200(쪽 {pb}개 · {len(ids_big)}건)과 같은 집합 — 빠짐 · 더함 없음(to 고정)", not missing and not extra, f"빠짐 {missing} 더함 {extra}")
    bad_range = [x["id"] for x in items if not (frm <= x["entered_at"][:19] + "Z" <= to)]
    check("alerts.history", "entered_at 이 [from, to] 안", not bad_range, str(bad_range[:5]))
    if items:
        h = items[0]["hex"]
        st, hx, _ = get(c, f"/api/v1/alerts/history?from={frm}&to={to}&limit=200&hex={h.upper()}")
        check("alerts.history", "hex 필터(대문자 입력) — 그 hex 만", st == 200 and hx["items"] and all(x["hex"] == h for x in hx["items"]), f"{st}")


# ------------------------------------------------------------------ 검색

def search(c):
    st, body, _ = get(c, "/api/v1/aircraft/search?q=7")
    check("aircraft.search", "q 1자 → 400", st == 400, str(st))
    for q in ("78", "CES", "B-"):
        st, body, _ = get(c, "/api/v1/aircraft/search?q=" + q)
        if st != 200:
            check("aircraft.search", f"q={q}", False, str(st))
            continue
        items = body["items"]
        badm = [i.get("hex") for i in items if not (str(i.get("hex", "")).upper().startswith(q) or str(i.get("callsign") or "").strip().upper().startswith(q)
                                                     or str(i.get("registration") or "").upper().startswith(q))]
        order = [i["live"] for i in items]
        check("aircraft.search", f"q={q}: ≤ 20 · 모두 접두 일치(응답에 보이는 hex · 호출부호 · 등록번호로) · 실시간 먼저",
              len(items) <= 20 and not badm and order == sorted(order, reverse=True),
              f"n={len(items)} 응답 필드로는 일치가 안 보이는 항목={badm[:4]}")
    for q, lim in (("4", 5), ("43", 5), ("432", 20), ("EVER", 10), ("432952000", 10)):
        st, body, _ = get(c, f"/api/v1/ships/search?q={q}&limit={lim}")
        if st != 200:
            check("ships.search", f"q={q} limit={lim}", st == 400 and len(q) < 2, f"{st} {(body or {}).get('detail')}")
            continue
        items = body["items"]
        keys_ok = all(len(i) == 13 for i in items)
        live = [i for i in items if i["live"]]
        lives_first = [i["live"] for i in items] == sorted([i["live"] for i in items], reverse=True)
        seen = [i["seen_at"] for i in live]
        # 정확 일치(9자리 MMSI · 선명 · 호출부호 · IMO 정확)는 앞 — 그 밖은 seen_at 내림차순
        nonexact = [i for i in live if i["mmsi"] != q and (i["name"] or "") != q and (i["call_sign"] or "") != q]
        ordered = [i["seen_at"] for i in nonexact] == sorted([i["seen_at"] for i in nonexact], reverse=True)
        check("ships.search", f"q={q} limit={lim}: n={len(items)} ≤ limit · 13키 · count · 실시간 먼저 · 최근 보고 순",
              len(items) <= lim and keys_ok and body["meta"]["count"] == len(items) and lives_first and ordered,
              f"keys={keys_ok} count={body['meta']['count']} lives_first={lives_first} ordered={ordered}")


# ------------------------------------------------------------------ 재생 · 통계

def replay_stats(c):
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    f = lambda t: quote(t.strftime("%Y-%m-%dT%H:%M:%SZ"))  # noqa: E731
    st, body, h = get(c, f"/api/v1/replay?at={f(now - dt.timedelta(minutes=5))}&bbox=124,33,132,39")
    check("replay", "5분 전: 200 · source track_point · 항공기 있음 · radar 있음", st == 200 and body["source"] == "track_point" and body["aircraft"] and body["radar"],
          f"{st} source={(body or {}).get('source')} n={len((body or {}).get('aircraft') or [])} radar={(body or {}).get('radar')}")
    if st == 200 and body["aircraft"]:
        at = now - dt.timedelta(minutes=5)
        off = [a["hex"] for a in body["aircraft"] if abs((dt.datetime.fromisoformat(a["ts"].replace("Z", "+00:00")) - at).total_seconds()) > 180]
        out = [a["hex"] for a in body["aircraft"] if not (124 <= a["lon"] <= 132 and 33 <= a["lat"] <= 39)]
        check("replay", "항공기 ts 가 at ± 3분 · bbox 안", not off and not out, f"창 밖 {off[:4]} bbox 밖 {out[:4]}")
    st, body, _ = get(c, f"/api/v1/replay?at={f(now - dt.timedelta(hours=3))}&bbox=124,33,132,39")
    check("replay", "3시간 전: radar null(RainViewer 2시간)", st == 200 and body.get("radar") is None, f"{st} radar={(body or {}).get('radar')}")
    st, body, _ = get(c, f"/api/v1/replay?at={f(now - dt.timedelta(days=31) + dt.timedelta(minutes=2))}&bbox=124,33,132,39")
    check("replay", "31일 − 2분: 200 · source none", st == 200 and body["source"] == "none", f"{st} {(body or {}).get('source')}")
    st, body, _ = get(c, f"/api/v1/replay?at={f(now - dt.timedelta(days=31, minutes=2))}&bbox=124,33,132,39")
    check("replay", "31일 + 2분: 400 BAD_AT", st == 400 and body.get("code") == "BAD_AT", f"{st}")
    today = now.astimezone(dt.timezone(dt.timedelta(hours=9))).date()
    st, body, _ = get(c, "/api/v1/stats/alerts")
    if st == 200:
        days = [d["day"] for d in body["days"]]
        want = [(today - dt.timedelta(days=i)).isoformat() for i in range(7, -1, -1)]
        check("stats", "기본 범위 = KST 오늘 − 7일 ~ 오늘(8일), day_zone Asia/Seoul", days == want and body["day_zone"] == "Asia/Seoul", f"{days[:2]}…{days[-2:]}")
        check("stats", "KST 오늘은 aggregated=false", body["days"][-1]["aggregated"] is False)
    st, body, _ = get(c, f"/api/v1/stats/sigmet?from={(today - dt.timedelta(days=92)).isoformat()}&to={today.isoformat()}&group=hazard")
    check("stats", "92일 범위 · days 93개 · group hazard", st == 200 and len(body["days"]) == 93 and body["group"] == "hazard", f"{st}")
    st, body, _ = get(c, "/api/v1/stats/traffic")
    check("stats", "traffic 기본 day = KST 오늘", st == 200 and body["day"] == today.isoformat(), f"{(body or {}).get('day')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8701")
    ap.add_argument("--out", default=OUT_DIR)
    a = ap.parse_args()
    c = Client(a.base)
    for fn in (aircraft, ships, times, alert_paging, search, replay_stats):
        try:
            fn(c)
        except Exception as e:  # 점검 하나가 넘어져도 나머지는 돈다
            check(fn.__name__, "예외", False, repr(e))
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    md = os.path.join(a.out, f"values-{stamp}.md")
    os.makedirs(a.out, exist_ok=True)
    with open(md, "w") as f:
        f.write(f"# 값 정확성 점검 — {stamp}\n\n- 대상 {a.base} · 명령 `python3 tools/qa/value_checks.py`\n\n| 영역 | 점검 | 결과 | 자세히 |\n|---|---|---|---|\n")
        for r in results:
            f.write(f"| {r['area']} | {r['name']} | {'통과' if r['ok'] else '**어긋남**'} | {r['detail'].replace('|', '/')[:400]} |\n")
    fails = [r for r in results if not r["ok"]]
    print(f"done: {len(results)} checks, {len(fails)} failed → {md}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
