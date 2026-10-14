#!/usr/bin/env python3
"""QA 2026-10-aws(api-live): bbox 2,500 sq° 의 /aircraft · /ships · /replay 응답 크기(원문 · gzip) · 시간(5회 중앙 · 최대) — 격리 스택 8701 만.

    python3 tools/qa/api_live_sizes.py
"""
import http.client, time, json, datetime as dt, statistics
def req(path, gz=False):
    c=http.client.HTTPConnection("localhost",8701,timeout=30)
    h={"Accept":"application/geo+json, application/json"}
    if gz: h["Accept-Encoding"]="gzip"
    t=time.perf_counter(); c.request("GET",path,headers=h); r=c.getresponse(); b=r.read(); ms=(time.perf_counter()-t)*1000; c.close()
    return r.status, len(b), ms, b
now=dt.datetime.now(dt.UTC)
out=[]
for label,path in [("aircraft 2500sq° detail=lite","/api/v1/aircraft?bbox=100,10,150,60"),("aircraft 2500sq° detail=full","/api/v1/aircraft?bbox=100,10,150,60&detail=full"),
                   ("ships 2500sq°","/api/v1/ships?bbox=100,10,150,60")]+[
                   (f"replay 2500sq° at-{m}m", f"/api/v1/replay?at={(now-dt.timedelta(minutes=m)).strftime('%Y-%m-%dT%H:%M:%SZ')}&bbox=100,10,150,60") for m in (1,5,30,60,90,180,600,1400)]:
    ms_l=[]; 
    for i in range(5):
        s,n,ms,b=req(path); ms_l.append(ms); time.sleep(0.15)
    s2,ngz,_,_=req(path,gz=True)
    try:
        j=json.loads(b); cnt=len(j.get("features", j.get("aircraft", [])))
        src=j.get("source")
    except Exception: cnt=None; src=None
    out.append((label,s,n,ngz,cnt,src,round(statistics.median(ms_l),1),round(max(ms_l),1)))
for o in out: print("%-34s %s %8dB gz=%7dB items=%s source=%s median=%sms max=%sms"%o)
