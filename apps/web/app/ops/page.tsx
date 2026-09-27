"use client";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { fmtTime } from "@/lib/format";

type Any = Record<string, unknown>;
interface Providers { providers: Any[]; active: Record<string, string>; collector: Record<string, string>; switches: Any[]; budget_days: Any[] }
interface Runs { items: Any[]; summary_24h: Any[] }
interface Quality { rule_counts: Any[]; recent: Any[] }
interface Settings { items: { key: string; value: unknown; version: number; updated_by?: string; updated_at?: string }[] }

/** 운영 화면(FR-13/14/25/27): 로그인(세션) 후 공급자·실행 이력·품질 게이트·설정·감사·DLQ. 비로그인은 404 → 로그인 폼. */
export default function OpsPage() {
  const [me, setMe] = useState<{ username: string } | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => { apiGet<{ username: string }>("/api/v1/ops/session").then(setMe).catch(() => setMe(null)).finally(() => setChecked(true)); }, []);
  if (!checked) return <div className="p-4 text-fg-3">…</div>;
  return me ? <OpsDashboard me={me} onLogout={() => setMe(null)} /> : <Login onLogin={setMe} />;
}

function Login({ onLogin }: { onLogin: (u: { username: string }) => void }) {
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try { onLogin(await apiSend<{ username: string }>("POST", "/api/v1/ops/session", { username: u, password: p })); }
    catch (x) { setErr(x instanceof ApiError && x.status === 401 ? "아이디 또는 비밀번호가 올바르지 않습니다(5회 실패 시 15분 잠금)." : (x as Error).message); }
  };
  return (
    <div className="grid-bg flex h-full items-center justify-center">
      <form onSubmit={submit} className="panel w-80 p-4" data-testid="ops-login">
        <div className="label mb-3">Operator sign-in</div>
        <label className="label block">username</label><input className="mb-2 w-full" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" />
        <label className="label block">password</label><input className="mb-3 w-full" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
        {err ? <div className="mb-2 text-[11px] text-bad">{err}</div> : null}
        <button className="btn w-full" type="submit">Sign in</button>
        <div className="mt-3 text-[10px] text-fg-3">계정은 `make ops-user` 로만 만듭니다. 세션 8 h · HttpOnly · SameSite=Strict · CSRF 이중 제출.</div>
      </form>
    </div>
  );
}

function OpsDashboard({ me, onLogout }: { me: { username: string }; onLogout: () => void }) {
  const [tab, setTab] = useState<"providers" | "runs" | "quality" | "settings" | "audit" | "dlq">("providers");
  const [prov, setProv] = useState<Providers | null>(null);
  const [runs, setRuns] = useState<Runs | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [audit, setAudit] = useState<{ items: Any[] } | null>(null);
  const [dlq, setDlq] = useState<{ items: Any[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(() => {
    setErr(null);
    const h = (e: Error) => setErr(e.message);
    apiGet<Providers>("/api/v1/ops/providers").then(setProv).catch(h);
    apiGet<Runs>("/api/v1/ops/runs?limit=50").then(setRuns).catch(h);
    apiGet<Quality>("/api/v1/ops/quality").then(setQuality).catch(h);
    apiGet<Settings>("/api/v1/ops/settings").then(setSettings).catch(h);
    apiGet<{ items: Any[] }>("/api/v1/ops/audit").then(setAudit).catch(h);
    apiGet<{ items: Any[] }>("/api/v1/ops/dlq").then(setDlq).catch(h);
  }, []);
  useEffect(() => { const first = setTimeout(refresh, 0); const t = setInterval(refresh, 15_000); return () => { clearTimeout(first); clearInterval(t); }; }, [refresh]);
  const logout = async () => { await apiSend("DELETE", "/api/v1/ops/session"); onLogout(); };
  const toggle = async (name: string, action: "enable" | "disable") => { try { await apiSend("POST", `/api/v1/ops/providers/${name}/${action}`); refresh(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="flex h-full flex-col" data-testid="ops-dashboard">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-bg-1 px-3">
        <span className="label mr-2">Operations</span>
        {(["providers", "runs", "quality", "settings", "audit", "dlq"] as const).map((t) => <button key={t} className="btn" aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}
        <button className="btn" onClick={refresh}>refresh</button>
        {err ? <span className="text-[11px] text-bad">{err}</span> : null}
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
              <td className={`mono ${Number(p.consecutive_failures) > 0 ? "text-warn" : ""}`}>{String(p.consecutive_failures ?? 0)}</td>
              <td className="mono">{String(p.budget_used ?? 0)} / {Number(p.budget_limit) > 0 ? String(p.budget_limit) : "∞"}</td><td className="mono">{String(p.budget_remaining ?? "—")}</td>
              <td className="max-w-[320px] truncate text-fg-3" title={String(p.last_error ?? "")}>{String(p.last_error ?? "")} {p.last_error_at ? fmtTime(String(p.last_error_at)) : ""}</td>
              <td>{p.disabled === "1" ? <button className="btn" onClick={() => toggle(String(p.name), "enable")}>enable</button> : <button className="btn" onClick={() => toggle(String(p.name), "disable")}>disable</button>}</td>
            </tr>)}</tbody></table>
          <div className="label mt-4 mb-1">Provider switches</div>
          <table><thead><tr><th>at</th><th>job</th><th>from → to</th><th>reason</th></tr></thead><tbody>{prov.switches.map((s, i) => <tr key={i}><td className="mono">{fmtTime(String(s.at))}</td><td>{String(s.job)}</td><td className="mono">{String(s.from)} → {String(s.to)}</td><td>{String(s.reason)}</td></tr>)}</tbody></table>
          <div className="label mt-4 mb-1">Daily budget snapshot</div>
          <table><thead><tr><th>day</th><th>provider</th><th>calls</th><th>limit</th></tr></thead><tbody>{prov.budget_days.map((b, i) => <tr key={i}><td className="mono">{String(b.day).slice(0, 10)}</td><td>{String(b.provider)}</td><td className="mono">{String(b.calls)}</td><td className="mono">{String(b.limit_value)}</td></tr>)}</tbody></table>
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
          <table className="mb-4"><thead><tr><th>day</th><th>rule</th><th>count</th></tr></thead><tbody>{quality.rule_counts.map((r, i) => <tr key={i}><td className="mono">{String(r.day).slice(0, 10)}</td><td>{String(r.rule)}</td><td className="mono">{String(r.count)}</td></tr>)}</tbody></table>
          <div className="label mb-1">Recent quarantined records (not shown on map, kept in raw)</div>
          <table><thead><tr><th>at</th><th>run</th><th>rule</th><th>hex</th><th>detail</th></tr></thead><tbody>{quality.recent.map((r) => <tr key={String(r.id)}><td className="mono">{fmtTime(String(r.created_at))}</td><td className="mono">{String(r.run_id)}</td><td>{String(r.rule)}</td><td className="mono">{String(r.hex ?? "")}</td><td className="mono text-fg-3">{String(r.detail)}</td></tr>)}</tbody></table>
        </> : null}
        {tab === "settings" && settings ? <SettingsForm items={settings.items} onSaved={refresh} /> : null}
        {tab === "audit" && audit ? <table><thead><tr><th>at</th><th>user</th><th>action</th><th>target</th><th>before</th><th>after</th><th>ip</th><th>request</th></tr></thead>
          <tbody>{audit.items.map((a) => <tr key={String(a.id)}><td className="mono">{fmtTime(String(a.at))}</td><td>{String(a.username ?? "")}</td><td>{String(a.action)}</td><td className="mono">{String(a.target ?? "")}</td><td className="mono text-fg-3">{String(a.before ?? "")}</td><td className="mono">{String(a.after ?? "")}</td><td className="mono">{String(a.ip ?? "")}</td><td className="mono text-fg-3">{String(a.request_id ?? "")}</td></tr>)}</tbody></table> : null}
        {tab === "dlq" && dlq ? (dlq.items.length ? <table><thead><tr><th>at</th><th>stream</th><th>kind</th><th>reason</th><th>payload head</th></tr></thead>
          <tbody>{dlq.items.map((d) => <tr key={String(d.stream_id)}><td className="mono">{fmtTime(String(d.at))}</td><td className="mono">{String(d.source_stream)}</td><td>{String(d.kind)}</td><td className="text-bad">{String(d.reason)}</td><td className="mono text-fg-3">{String(d.payload_head)}</td></tr>)}</tbody></table> : <div className="text-fg-3">스키마 검증에 실패한 메시지가 없습니다.</div>) : null}
      </div>
    </div>
  );
}

function SettingsForm({ items, onSaved }: { items: Settings["items"]; onSaved: () => void }) {
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (k: string, version: number) => {
    const raw = edit[k];
    if (raw === undefined) return;
    let value: unknown = raw;
    if (/^-?\d+$/.test(raw)) value = Number(raw); else if (raw === "true" || raw === "false") value = raw === "true";
    try { await apiSend("PUT", `/api/v1/ops/settings/${k}`, { value }, { "If-Match": String(version) }); setMsg(`${k} 저장됨 — 다음 주기부터 적용`); setEdit((e) => { const c = { ...e }; delete c[k]; return c; }); onSaved(); }
    catch (e) { setMsg(`${k}: ${(e as Error).message}`); }
  };
  return (
    <div>
      <div className="mb-2 text-[11px] text-fg-3">변경은 If-Match(version) 낙관적 잠금 + CSRF 헤더로 보호되며 감사 로그에 남습니다. collector 는 다음 주기에 반영합니다.</div>
      {msg ? <div className="mb-2 text-[11px] text-accent">{msg}</div> : null}
      <table><thead><tr><th>key</th><th>value</th><th>version</th><th>updated</th><th></th></tr></thead>
        <tbody>{items.map((s) => <tr key={s.key}><td className="mono">{s.key}</td>
          <td><input className="mono w-72" value={edit[s.key] ?? String(s.value)} onChange={(e) => setEdit({ ...edit, [s.key]: e.target.value })} /></td>
          <td className="mono">{s.version}</td><td className="mono text-fg-3">{s.updated_by ?? "—"} {fmtTime(s.updated_at)}</td>
          <td><button className="btn" onClick={() => save(s.key, s.version)} disabled={edit[s.key] === undefined}>save</button></td></tr>)}</tbody></table>
    </div>
  );
}
