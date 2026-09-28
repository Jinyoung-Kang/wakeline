"use client";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { fmtBudgetLimit, fmtClock, fmtTime } from "@/lib/format";
import {
  classifyOpsError, editSetting, isAuthMiss, OPS_SESSION_PATH, parseSetting, pipelineLossCount, rebaseSetting, SESSION_EXPIRED_NOTE, settingConflict, settingIfMatch, settingSpec,
  signOut, type SettingEdit,
} from "@/lib/ops";
import { OpsLogin } from "@/components/OpsLogin";
import { OpsPipeline } from "@/components/OpsPipeline";
import { ErrorNote } from "@/components/logs/ErrorNote";
import { statsDay } from "@/lib/stats";

type Any = Record<string, unknown>;
interface Providers { providers: Any[]; active: Record<string, string>; collector: Record<string, string>; switches: Any[]; budget_days: Any[] }
interface Runs { items: Any[]; summary_24h: Any[] }
interface Quality { rule_counts: Any[]; recent: Any[] }
interface Settings { items: { key: string; value: unknown; version: number; updated_by?: string; updated_at?: string }[] }
type Tab = "providers" | "runs" | "quality" | "settings" | "audit" | "dlq" | "pipeline";
const TABS: readonly Tab[] = ["providers", "runs", "quality", "settings", "audit", "dlq", "pipeline"];
/** 탭마다 불러오는 엔드포인트 — 마지막 성공 시각·실패를 탭마다 따로 둔다(R-12) */
const TAB_PATH: Record<Tab, string> = {
  providers: "/api/v1/ops/providers", runs: "/api/v1/ops/runs?limit=50", quality: "/api/v1/ops/quality", settings: "/api/v1/ops/settings",
  audit: "/api/v1/ops/audit", dlq: "/api/v1/ops/dlq", pipeline: "/api/v1/ops/pipeline",
};

/**
 * 운영 화면(FR-13/14/25/27): 로그인(세션) 후 공급자·실행 이력·품질 게이트·설정·감사·DLQ·파이프라인 손실 지표(R-18). 비로그인은 404 → 로그인 폼.
 * 세션이 만료되면(ops 호출 401/404 + 세션 확인도 401/404) 대시보드를 지우고 로그인으로 돌아간다. 로그아웃은 실패해도 로그인으로(R-12).
 * 시각은 모두 날짜 포함(MM-DD HH:MM:SSZ) — 감사·실행 이력은 날짜가 바뀌어도 모호하지 않아야 한다. 모르는 값은 "—"(0 으로 채우지 않는다).
 */
export default function OpsPage() {
  const [me, setMe] = useState<{ username: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { apiGet<{ username: string }>(OPS_SESSION_PATH).then(setMe).catch(() => setMe(null)).finally(() => setChecked(true)); }, []);
  const leave = useCallback((note: string | null) => { setNotice(note); setMe(null); }, []);
  const login = useCallback((u: { username: string }) => { setNotice(null); setMe(u); }, []);
  if (!checked) return <div className="p-4 text-fg-3"><h1 className="sr-only">운영</h1>…</div>;
  return <><h1 className="sr-only">운영{me ? "" : " — 로그인"}</h1>{me ? <OpsDashboard me={me} onLeave={leave} /> : <OpsLogin onLogin={login} notice={notice} />}</>;
}

function OpsDashboard({ me, onLeave }: { me: { username: string }; onLeave: (note: string | null) => void }) {
  const [tab, setTab] = useState<Tab>("providers");
  const [prov, setProv] = useState<Providers | null>(null);
  const [runs, setRuns] = useState<Runs | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [audit, setAudit] = useState<{ items: Any[] } | null>(null);
  const [dlq, setDlq] = useState<{ items: Any[] } | null>(null);
  const [pipeline, setPipeline] = useState<unknown>(null);
  /** 마지막 오류(문구 + ApiError 면 요청 id — 계약 v5 §C8) */
  const [err, setErr] = useState<unknown>(null);
  /** 탭(엔드포인트)마다 마지막 성공 시각과 마지막 요청의 실패(성공하면 지운다) — 한 탭만 계속 실패해도 드러난다(R-12) */
  const [lastOk, setLastOk] = useState<Partial<Record<Tab, number>>>({});
  const [tabErr, setTabErr] = useState<Partial<Record<Tab, unknown>>>({});
  /** 오류 처리: 세션 만료면 로그인으로(대시보드 상태는 언마운트로 사라진다), 아니면 오류 문구 */
  const fail = useCallback((e: unknown) => {
    if (!isAuthMiss(e)) { setErr(e); return; }
    void classifyOpsError(e, () => apiGet(OPS_SESSION_PATH)).then((k) => (k === "expired" ? onLeave(SESSION_EXPIRED_NOTE) : setErr(e)));
  }, [onLeave]);
  const refresh = useCallback(() => {
    setErr(null);
    let authMiss = false; // 한 번의 새로고침에서 세션 확인은 한 번만
    const load = <T,>(t: Tab, set: (v: T) => void) => apiGet<T>(TAB_PATH[t]).then(
      (v) => { set(v); setLastOk((o) => ({ ...o, [t]: Date.now() })); setTabErr((m) => { const c = { ...m }; delete c[t]; return c; }); },
      (e: unknown) => {
        // 이 탭의 값은 마지막 성공 시각 기준으로 남는다 — 실패를 탭에 붙인다. 세션 만료면 로그인으로(확인은 한 번만)
        setTabErr((m) => ({ ...m, [t]: e }));
        if (!isAuthMiss(e) || authMiss) return;
        authMiss = true;
        void classifyOpsError(e, () => apiGet(OPS_SESSION_PATH)).then((k) => { if (k === "expired") onLeave(SESSION_EXPIRED_NOTE); });
      });
    load<Providers>("providers", setProv);
    load<Runs>("runs", setRuns);
    load<Quality>("quality", setQuality);
    load<Settings>("settings", setSettings);
    load<{ items: Any[] }>("audit", setAudit);
    load<{ items: Any[] }>("dlq", setDlq);
    load<unknown>("pipeline", setPipeline);
  }, [onLeave]);
  useEffect(() => { const first = setTimeout(refresh, 0); const t = setInterval(refresh, 15_000); return () => { clearTimeout(first); clearInterval(t); }; }, [refresh]);
  const logout = () => { void signOut(() => apiSend("DELETE", OPS_SESSION_PATH), onLeave); };
  const losses = pipelineLossCount(pipeline);
  const toggle = async (name: string, action: "enable" | "disable") => { try { await apiSend("POST", `/api/v1/ops/providers/${name}/${action}`); refresh(); } catch (e) { fail(e); } };
  return (
    <div className="flex h-full flex-col" data-testid="ops-dashboard">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg-1 px-3 py-1">
        <span className="label mr-2">Operations</span>
        <div className="flex gap-1" role="group" aria-label="운영 탭">{TABS.map((t) => (
          <button key={t} className="btn" aria-pressed={tab === t} onClick={() => setTab(t)} data-testid={`ops-tab-${t}`}>
            {t}{t === "pipeline" && losses ? <span className="ml-1 text-bad" title="0 이 아닌 손실 지표 수">● {losses}</span> : null}
            {tabErr[t] ? <span className="ml-1 text-warn" title={`마지막 요청 실패 — 표시 값은 ${fmtClock(lastOk[t])} 기준`} data-testid="ops-tab-stale">갱신 실패</span> : null}
          </button>
        ))}</div>
        <button className="btn" onClick={refresh}>refresh</button>
        <span className={`mono text-[11px] ${tabErr[tab] ? "text-warn" : "text-fg-3"}`} title={`이 탭(${TAB_PATH[tab]})의 마지막 성공 응답 시각 — 15 s 마다 다시 요청`} data-testid="ops-last-ok">갱신 {fmtClock(lastOk[tab])}</span>
        {err || TABS.some((t) => tabErr[t]) ? (
          <span className="text-[11px] text-bad" role="alert">
            {TABS.filter((t) => tabErr[t]).map((t, i) => <span key={t}>{i ? " · " : ""}<ErrorNote prefix={`${t}: `} error={tabErr[t]} /></span>)}
            {err ? <>{TABS.some((t) => tabErr[t]) ? " · " : ""}<ErrorNote error={err} /></> : null}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-fg-3">{me.username}</span><button className="btn" onClick={logout}>sign out</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-[12px]">
        {tab === "providers" && prov ? <>
          <div className="mb-2 flex flex-wrap gap-3 text-[11px]">
            {Object.entries(prov.active ?? {}).filter(([k]) => !k.includes("_")).map(([job, name]) => <span key={job} className="badge ok">{job}: {name}</span>)}
            {Object.entries(prov.collector ?? {}).filter(([k]) => k.endsWith("_at")).map(([k, v]) => <span key={k} className="mono text-fg-3">{k.replace("_at", "")} {fmtTime(String(v))}</span>)}
            {prov.collector?.fixture === "1" ? <span className="badge warn">FIXTURE</span> : null}
          </div>
          <table><thead><tr><th>provider</th><th>last success</th><th>latency</th><th>records</th><th>fails</th><th>budget used / limit</th><th>remaining (hdr)</th><th>last error</th><th>manual</th></tr></thead>
            <tbody>{prov.providers.map((p) => <tr key={String(p.name)}>
              <td className="mono">{String(p.name)}{p.disabled === "1" ? <span className="badge bad ml-1">disabled</span> : null}</td>
              <td className="mono">{fmtTime(String(p.last_success_at ?? ""))}</td><td className="mono">{String(p.last_latency_ms ?? "—")} ms</td><td className="mono">{String(p.last_records ?? "—")}</td>
              <td className={`mono ${Number(p.consecutive_failures) > 0 ? "text-warn" : ""}`}>{String(p.consecutive_failures ?? "—")}</td>
              <td className="mono" title="한도 — = 아직 보고되지 않음(성공한 수집이 없음) · ∞ = 한도 0(설정상 무제한)">{String(p.budget_used ?? "—")} / {fmtBudgetLimit(p.budget_limit)}</td><td className="mono">{String(p.budget_remaining ?? "—")}</td>
              <td className="max-w-[320px] truncate text-fg-3" title={String(p.last_error ?? "")}>{String(p.last_error ?? "")} {p.last_error_at ? fmtTime(String(p.last_error_at)) : ""}</td>
              <td>{p.disabled === "1" ? <button className="btn" onClick={() => toggle(String(p.name), "enable")}>enable</button> : <button className="btn" onClick={() => toggle(String(p.name), "disable")}>disable</button>}</td>
            </tr>)}</tbody></table>
          <div className="label mt-4 mb-1">Provider switches</div>
          <table><thead><tr><th>at</th><th>job</th><th>from → to</th><th>reason</th></tr></thead><tbody>{prov.switches.map((s, i) => <tr key={i}><td className="mono">{fmtTime(String(s.at))}</td><td>{String(s.job)}</td><td className="mono">{String(s.from)} → {String(s.to)}</td><td>{String(s.reason)}</td></tr>)}</tbody></table>
          <div className="label mt-4 mb-1">Daily budget snapshot</div>
          <table><thead><tr><th>day</th><th>provider</th><th>calls</th><th>limit</th></tr></thead><tbody>{prov.budget_days.map((b, i) => <tr key={i}><td className="mono">{statsDay(b.day) ?? "—"}</td><td>{String(b.provider)}</td><td className="mono">{String(b.calls)}</td><td className="mono">{String(b.limit_value)}</td></tr>)}</tbody></table>
        </> : null}
        {tab === "runs" && runs ? <>
          <div className="label mb-1">Last 24 h</div>
          <table className="mb-4"><thead><tr><th>job</th><th>provider</th><th>status</th><th>n</th><th>avg latency</th><th>last</th></tr></thead><tbody>{runs.summary_24h.map((s, i) => <tr key={i}><td>{String(s.job)}</td><td>{String(s.provider)}</td><td className={String(s.status) === "ok" ? "text-ok" : "text-warn"}>{String(s.status)}</td><td className="mono">{String(s.n)}</td><td className="mono">{String(s.avg_latency_ms ?? "—")} ms</td><td className="mono">{fmtTime(String(s.last_at))}</td></tr>)}</tbody></table>
          <div className="label mb-1">Recent runs (errors masked, copy raw)</div>
          <table><thead><tr><th>id</th><th>job</th><th>provider</th><th>started</th><th>status</th><th>http</th><th>ms</th><th>in / quarantined</th><th>raw_ref</th><th>error</th></tr></thead>
            <tbody>{runs.items.map((r) => <tr key={String(r.id)}><td className="mono">{String(r.id)}</td><td>{String(r.job)}</td><td>{String(r.provider)}</td><td className="mono">{fmtTime(String(r.started_at))}</td><td className={String(r.status) === "ok" ? "text-ok" : "text-bad"}>{String(r.status)}</td><td className="mono">{String(r.http_status ?? "")}</td><td className="mono">{String(r.latency_ms ?? "")}</td><td className="mono">{String(r.records_in)} / {String(r.records_quarantined)}</td><td className="mono text-fg-3">{String(r.raw_ref ?? "")}</td><td>{r.error_text ? <pre className="mono max-w-[360px] whitespace-pre-wrap text-[10px] text-fg-2">{String(r.error_text)}</pre> : null}</td></tr>)}</tbody></table>
        </> : null}
        {tab === "quality" && quality ? <>
          <div className="label mb-1">Quarantine counts by rule (7d)</div>
          <table className="mb-4"><thead><tr><th>day</th><th>rule</th><th>count</th></tr></thead><tbody>{quality.rule_counts.map((r, i) => <tr key={i}><td className="mono">{statsDay(r.day) ?? "—"}</td><td>{String(r.rule)}</td><td className="mono">{String(r.count)}</td></tr>)}</tbody></table>
          <div className="label mb-1">Recent quarantined records (not shown on map, kept in raw)</div>
          <table><thead><tr><th>at</th><th>run</th><th>rule</th><th>hex</th><th>detail</th></tr></thead><tbody>{quality.recent.map((r) => <tr key={String(r.id)}><td className="mono">{fmtTime(String(r.created_at))}</td><td className="mono">{String(r.run_id)}</td><td>{String(r.rule)}</td><td className="mono">{String(r.hex ?? "")}</td><td className="mono text-fg-3">{String(r.detail)}</td></tr>)}</tbody></table>
        </> : null}
        {tab === "pipeline" && pipeline ? <OpsPipeline data={pipeline} /> : null}
        {tab === "settings" && settings ? <SettingsForm items={settings.items} onSaved={refresh} onAuthMiss={fail} /> : null}
        {tab === "audit" && audit ? <table><thead><tr><th>at</th><th>user</th><th>action</th><th>target</th><th>before</th><th>after</th><th>ip</th><th>request</th></tr></thead>
          <tbody>{audit.items.map((a) => <tr key={String(a.id)}><td className="mono">{fmtTime(String(a.at))}</td><td>{String(a.username ?? "")}</td><td>{String(a.action)}</td><td className="mono">{String(a.target ?? "")}</td><td className="mono text-fg-3">{String(a.before ?? "")}</td><td className="mono">{String(a.after ?? "")}</td><td className="mono">{String(a.ip ?? "")}</td><td className="mono text-fg-3">{String(a.request_id ?? "")}</td></tr>)}</tbody></table> : null}
        {tab === "dlq" && dlq ? (dlq.items.length ? <table><thead><tr><th>at</th><th>stream</th><th>kind</th><th>reason</th><th>payload head</th></tr></thead>
          <tbody>{dlq.items.map((d) => <tr key={String(d.stream_id)}><td className="mono">{fmtTime(String(d.at))}</td><td className="mono">{String(d.source_stream)}</td><td>{String(d.kind)}</td><td className="text-bad">{String(d.reason)}</td><td className="mono text-fg-3">{String(d.payload_head)}</td></tr>)}</tbody></table> : <div className="text-fg-3">스키마 검증에 실패한 메시지가 없습니다.</div>) : null}
      </div>
    </div>
  );
}

function SettingsForm({ items, onSaved, onAuthMiss }: { items: Settings["items"]; onSaved: () => void; onAuthMiss: (e: unknown) => void }) {
  // 편집 값과 편집을 시작할 때 본 version(R-35): 15 s 새로고침이 version 을 바꿔도 저장은 처음 본 version 으로 If-Match 한다
  const [edit, setEdit] = useState<Record<string, SettingEdit>>({});
  // 결과 문구: 성공(ok, role=status)과 실패(bad, role=alert)를 색·역할로 구분한다(R-56)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const drop = (k: string) => setEdit((e) => { const c = { ...e }; delete c[k]; return c; });
  const save = async (k: string) => {
    const ed = edit[k];
    if (ed === undefined) return;
    // 서버 검증 규칙(SettingsService.validate)을 보내기 전에 — 규칙을 모르는 키는 서버가 검사
    const parsed = parseSetting(k, ed.value);
    if (!parsed.ok) { setFieldErr((f) => ({ ...f, [k]: parsed.error })); setMsg({ ok: false, text: `${k}: 저장하지 않음 — ${parsed.error}` }); return; }
    setFieldErr((f) => { const c = { ...f }; delete c[k]; return c; });
    try { await apiSend("PUT", `/api/v1/ops/settings/${k}`, { value: parsed.value }, { "If-Match": settingIfMatch(ed) }); setMsg({ ok: true, text: `${k} 저장됨 — 다음 주기부터 적용` }); drop(k); onSaved(); }
    catch (e) {
      if (isAuthMiss(e)) onAuthMiss(e);
      const conflict = e instanceof ApiError && e.status === 409;
      const text = conflict ? "편집하는 동안 다른 곳에서 바뀌었습니다 — 새 값을 확인한 뒤 다시 저장하세요"
        : e instanceof ApiError && e.status === 400 ? `서버가 값을 거절했습니다(${e.message})`
        : e instanceof ApiError ? `저장 실패(HTTP ${e.status})` : "서버에 연결할 수 없습니다(네트워크)";
      setMsg({ ok: false, text: `${k}: ${text}` });
      if (conflict) onSaved(); // 새 값·version 을 바로 받아 충돌 표시
    }
  };
  return (
    <div>
      <div className="mb-2 text-[11px] text-fg-3">변경은 If-Match(version) 낙관적 잠금 + CSRF 헤더로 보호되며 감사 로그에 남습니다. collector 는 다음 주기에 반영합니다. 편집하는 동안 서버 값이 바뀌면 행에 표시하고, 덮어쓰기는 직접 골라야 합니다.</div>
      <div className="mb-2 text-[11px] text-fg-3"><span className="mono">ais_bboxes</span>: 선박 수신 영역 <span className="mono">lat1,lon1,lat2,lon2</span>(여러 상자는 <span className="mono">;</span>) · 비우면 .env <span className="mono">AIS_BBOXES</span> · 전세계 <span className="mono">-90,-180,90,180</span> · ais 가 30 s 안에 같은 연결로 다시 구독합니다.</div>
      <div role="status" aria-live="polite">{msg?.ok ? <div className="mb-2 text-[11px] text-ok" data-testid="settings-ok">{msg.text}</div> : null}</div>
      {msg && !msg.ok ? <div className="mb-2 text-[11px] text-bad" role="alert" data-testid="settings-error">{msg.text}</div> : null}
      <table><thead><tr><th>key</th><th>value</th><th>version</th><th>updated</th><th></th></tr></thead>
        <tbody>{items.map((s) => {
          const ed = edit[s.key];
          const conflict = settingConflict(ed, s);
          return <tr key={s.key} data-testid="setting-row" data-conflict={conflict ? "true" : undefined}><td className="mono">{s.key}</td>
            <td>
              <SettingInput k={s.key} value={ed?.value ?? String(s.value)} error={fieldErr[s.key] ?? null} onChange={(v) => setEdit({ ...edit, [s.key]: editSetting(ed, s, v) })} />
              {conflict && ed ? (
                <div className="mt-1 text-[11px] text-warn" role="alert" data-testid="setting-conflict">
                  편집하는 동안 서버 값이 바뀜(v{ed.version} → v{s.version}: <span className="mono">{String(s.value)}</span>)
                  <button className="btn ml-1" onClick={() => drop(s.key)}>새 값 보기</button>
                  <button className="btn ml-1" onClick={() => setEdit({ ...edit, [s.key]: rebaseSetting(ed, s) })}>내 값으로 덮어쓰기</button>
                </div>
              ) : null}
            </td>
            <td className="mono">{s.version}</td><td className="mono text-fg-3">{s.updated_by ?? "—"} {fmtTime(s.updated_at)}</td>
            <td><button className="btn" onClick={() => save(s.key)} disabled={ed === undefined || conflict} title={conflict ? "서버 값이 바뀜 — 새 값 보기 또는 덮어쓰기를 먼저 고르세요" : undefined}>save</button></td></tr>;
        })}</tbody></table>
    </div>
  );
}

/** 키별 입력(R-56): 정수 → number(min/max), 켜기/끄기 → checkbox, 형식이 정해진 문자열 → text + 형식 안내. 값은 문자열로 편집한다(R-35 편집 상태). */
function SettingInput({ k, value, error, onChange }: { k: string; value: string; error: string | null; onChange: (v: string) => void }) {
  const spec = settingSpec(k);
  const describedBy = error ? `setting-err-${k}` : spec && spec.kind !== "bool" ? `setting-hint-${k}` : undefined;
  const common = { "aria-label": `${k} 값`, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy };
  return (
    <div>
      {spec?.kind === "bool" ? (
        <label className="flex items-center gap-2"><input type="checkbox" {...common} checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "false")} /><span className="mono">{value === "true" ? "켜짐" : "꺼짐"}</span></label>
      ) : spec?.kind === "int" ? (
        <input type="number" className="mono w-40" {...common} min={spec.min} max={spec.max} step={1} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="mono w-72 max-w-full" {...common} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {spec && spec.kind !== "bool" && !error ? <div id={`setting-hint-${k}`} className="text-[10px] text-fg-3">{spec.kind === "int" ? `정수 ${spec.min}–${spec.max} ${spec.unit}` : spec.hint}</div> : null}
      {error ? <div id={`setting-err-${k}`} className="text-[11px] text-bad">{error}</div> : null}
    </div>
  );
}
