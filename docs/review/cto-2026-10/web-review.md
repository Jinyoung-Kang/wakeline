# Wakeline web (`apps/web`) — frontend review: side effects, structure, bugs, performance

Scope: `apps/web` at `e0e1eba` (main, clean tree). Next 16.3.6 App Router · React 19.3.0 · zustand 5 · MapLibre 6.11.2 · Tailwind 4 · Vitest 5.0.2 · Playwright 1.63.

**How this was produced (read-only):**

- Every component, page and side-effecting `lib` module was read in full: `MapView`, the cards, search, ops and logs, replay, stats, and the airport page. `lib/api.ts`, `lib/ws.ts`, `lib/store.ts`, `lib/clock.ts`, `lib/etag-poller.ts`, `lib/replay.ts` (ReplayLoader), `lib/ops.ts` (RequestOrder) and `lib/map-ready.ts` were also read.
- Baseline commands:
  - `npx --no-install vitest run`: **96 files, 1,413 tests, all pass in 11.1 s**.
  - `npx --no-install eslint .`: clean.
  - `npx --no-install tsc --noEmit -p .`: clean.
  - `node scripts/check-first-screen-js.mjs` on the existing `.next`: read-only, see §5.
- Every finding marked **REPRODUCED** fails today with a vitest test. Those tests live outside the repo in `scratchpad/repro/*.repro.test.ts`. They run with a scratch config (`scratchpad/repro/vitest.repro.config.mjs`) whose `root` is `apps/web` and whose cache is in the scratchpad. No repo file was created or changed; `git status` is clean afterwards.
  - All 11 repro tests fail as described. The run command is in Appendix A, and so is the code adapted to repo conventions (`./helpers/mini-dom`, `vi.stubGlobal("fetch")`), ready to drop into `tests/`.
- Performance numbers are **measured**: React `<Profiler>` in the repo's mini-DOM plus `performance.now()` timing of `lib` functions. Environment: Node v24.3.0, Apple M1, React development build as run by vitest. Probe code is in Appendix B. No number below is an estimate unless it says so.

**Next.js behaviour this review relies on** (checked in `node_modules/next`, not from memory):

1. `error.tsx` / `global-error.tsx` receive `{ error, retry }`. See `docs/01-app/03-api-reference/03-file-conventions/error.md:117`; the version table at `:331` records "v16.3.0 — `retry` prop became stable". The app's boundaries are correct.
2. Routes are kept alive in a hidden `<Activity>` **only** with `cacheComponents: true`. Evidence: `docs/01-app/02-guides/preserving-ui-state.md`, and `dist/client/components/layout-router.js:683-690` (`if (process.env.__NEXT_CACHE_COMPONENTS) … <Activity mode=…>`). `next.config.ts` does not enable it, so leaving a route unmounts it. This matters for B8.
3. A dynamic-segment change remounts the segment, because each segment is keyed by `createRouterCacheKey(segment)` (`layout-router.js:549, 673`). So `/airports/A → /airports/B` remounts the airport page.
4. `reactStrictMode: true` is set (`next.config.ts`), so `next dev` double-invokes effects. That matters for B8.

**Corrections to the orchestrator's context:**

- Tests: there are **96** `*.test.ts` files plus 9 helpers in `tests/helpers` (not 105 test files). E2E has **12** specs plus 2 injection helpers.
- API call sites go beyond the listed ones:
  - `apiSend` is also used at `app/ops/page.tsx:259` (DELETE session), `:264` (POST provider toggle) and `:407` (PUT setting), at `components/logs/LogsDashboard.tsx:287` (DELETE session), at `components/OpsLogin.tsx:22`, and at `components/ResolveConfirm.tsx:115,126`.
  - `apiGet` is also used at `AircraftSearch.tsx:93,99,117`, `AirportList.tsx:19`, `SigmetCard.tsx:27`, `logs/LogsDashboard.tsx:99,103,114,120,146,156,175,229,242,315` and `logs/LogDetail.tsx:53,62`.
  - Raw `fetch` is used in `lib/etag-poller.ts:71` (traffic grid and reception layers: conditional GET / 304), in `lib/errorReport.ts` (keepalive POST) and in `lib/chunk-probe.ts:51` (HEAD with timeout).
  - Several endpoint builders already live in `lib`:
    - `logsUrl`, `logGroupsUrl` and `logItemUrl` (`lib/logs.ts:215-241`)
    - `runsDrillPath` (`lib/ops-runs.ts:33`)
    - `replayApiPath` (`lib/replay.ts:245`)
    - `resolutionPath` (`lib/resolutions.ts:13`)
    - `OPS_SESSION_PATH` (`lib/ops.ts:8`)
    - `TRAFFIC_URL` and `RECEPTION_URL`
- First-screen JS:
  - On this host's Node (zlib 1.2.12) the current `.next` measures **541,194 B, leaving 8,806 B headroom**.
  - The budget reference is the web image's Node (`--in-image`). The script header and docs/PERF.md §10 say it compresses about 0.44 % larger, which gives ≈ 543.6 kB and **≈ 6.4 KB headroom**. That agrees with the orchestrator's figure.
  - Compare only `--in-image` numbers between commits.

---

## Top findings

| # | Sev | Finding | Where | Status |
|---|-----|---------|-------|--------|
| B1 | **Med** | Clicking "이전 항목 더 보기" twice before the page arrives appends the same page twice. The hidden-resolved, skipped and page sums are inflated: "숨김 **8건**(불러온 **3쪽**)" instead of "5건(2쪽)". | `components/logs/LogsDashboard.tsx:238-248, 480` | **REPRODUCED** |
| B2 | **Med** | A double click on settings "save" sends 2 PUTs with the same If-Match. The duplicate's 409 replaces the success message with "편집하는 동안 다른 곳에서 바뀌었습니다", even though the save succeeded. The provider toggle has the same missing guard. | `app/ops/page.tsx:400-417, 440`, `:263-265` | **REPRODUCED** |
| B3 | **Med** | Search race: choose aircraft A (no live position, so a REST lookup starts), then B. A's late answer moves the map to A (`flyTo {lon:20,lat:10}`) and overwrites the status message while B is selected. | `components/AircraftSearch.tsx:110-124` | **REPRODUCED** |
| B4 | **Med** | A failed provider enable/disable shows its error. The next 15 s periodic reload silently clears it, because `reload()` always calls `setErr(null)`. | `app/ops/page.tsx:198, 233, 264` | **REPRODUCED** |
| B5 | Low-Med | AirportCard shows the previous airport's error, including its **request id and "로그 보기" link**, under the next airport while that one loads. The error is not keyed by icao, although `wx` is. | `components/AirportCard.tsx:32, 35-39, 50` | **REPRODUCED** |
| B6 | Low-Med | `EtagPoller` publishes answers that land after `stop()`. A stopped poller's late answer overwrites the replacing poller's state in the store. Affects the traffic-grid and reception layers. | `lib/etag-poller.ts:58-89`, used at `MapView.tsx:558-563`, `ReceptionLayer.tsx:37-41` | **REPRODUCED** |
| B7 | Low-Med (a11y) | The map-chip container is `aria-live="polite"`, and its text carries live ship counts that change with every ships message (server fan-out at most every 10 s). Screen readers re-announce the counts each time. | `components/MapChips.tsx:64`, `lib/ships.ts:1167`, `apps/api/.../ShipFanout.java:84` | **REPRODUCED** |
| B8 | Low (dev now; prod if `cacheComponents` is enabled) | MapView's "already applied" caches (`sigmetApplied`, `coverageKey` and four more refs) outlive the map they describe. After an effect re-run that creates a new map (StrictMode, or Activity), SIGMETs and the AIS coverage outline are not drawn. | `components/MapView.tsx:151, 441-442, 682-692` (also 118, 129, 471, 492) | **REPRODUCED** (StrictMode) |
| B9 | Low | The KR-radar poll has no in-flight or out-of-order guard and does not refresh when the tab is shown again. With a hung request, 6 requests stack up after 5 min. The airports poll and the AircraftCard 30 s refresh use the same pattern; for AircraftCard, answers slower than 30 s are always dropped. | `MapView.tsx:349-356`, `AircraftCard.tsx:175-185` | **REPRODUCED** (stacking; the edge caps upstream at 30 s, see B9) |
| B10 | Low | REST bodies that feed the shared store are cast, not validated; every WS message is validated. A 200 `/api/v1/radar/kr` body with `available:true` and no `frames` throws in `RadarTimeline` render, and the route error boundary replaces the whole dashboard. | `MapView.tsx:349`, `RadarTimeline.tsx:54` | **REPRODUCED** |
| B11 | Low (hygiene) | Path params from server data are not encoded: the authenticated POST `/api/v1/ops/providers/${name}/${action}`, the PUT `/api/v1/ops/settings/${k}`, and the link `/airports/${icao}`. | `app/ops/page.tsx:264, 407`, `AirportCard.tsx:48` | inspection |
| B12 | Low | Polls ignore a hidden tab, unlike the WS client, the worker and EtagPoller. AircraftCard polls every 30 s. Ops polls 7 endpoints every 15 s, which is 28 req/min in a background tab. Logs polls every 15 s. | `AircraftCard.tsx:175-178`, `app/ops/page.tsx:231-235`, `LogsDashboard.tsx:166-170` | inspection |
| B13 | Low | The Logs auto-check interval is torn down and re-armed whenever `page` or `groups` change, because the `poll` closure deps include them. | `LogsDashboard.tsx:142-170` | inspection |
| B14 | Low | `openById` has no sequence guard: when two `#id=` links are clicked quickly, the older answer can win. | `LogsDashboard.tsx:172-184` | inspection |
| B15 | Low | The ops/logs session check treats any failure (500, network) as "not logged in" and shows the login form. The logic is duplicated in two pages. | `app/ops/page.tsx:146`, `app/logs/page.tsx:16` | inspection |
| B16 | Low (latent) | `apiGet` merges headers by object spread, so a `Headers` instance would be dropped silently. No REST call has a timeout, although `lib/chunk-probe.ts` already shows the pattern. | `lib/api.ts:3` | inspection |
| B17 | Low | `AisGapsTable` keeps the previous period's error while the next period loads (same class as B5). The airport history page has no loading status (an empty body until loaded) and never clears `err`. | `logs/AisGapsTable.tsx:20-29`, `app/airports/[icao]/page.tsx:32` | inspection |

**XSS:** none found.

- There are no `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `document.write` or `eval` calls anywhere in `app`, `components`, `lib`, `proxy.ts` or the worker.
- Map tooltips are built with `textContent` (`lib/tooltip.ts:187-217`).
- The only HTML string, MapLibre's `customAttribution`, is built from constants and escaped (`lib/attribution.ts:50-63`).
- `RequestIdOf` and `ErrorNote` links validate ids with `REQUEST_ID_RE` and encode them (`components/logs/ErrorNote.tsx:50`).
- CSP uses nonce + `strict-dynamic` (`proxy.ts`).

**Proposed structure, in one paragraph:**

- Keep `lib/api.ts` as the transport.
- Add endpoint-specific modules in **`lib/endpoints/{aircraft,ships,weather,stats,replay,ops,logs}.ts`**. They are typed, take an `AbortSignal`, encode their params, reuse the existing URL builders, and import `apiGet`/`apiSend` from `@/lib/api`, so the 7 test files that `vi.mock("@/lib/api")` keep working.
- Add two generic hooks:
  - **`useApiResource(key, load, {refreshMs})`**, generalised from the existing, correct `useLoad` in `app/stats/page.tsx:98-111`.
  - **`useVisibleInterval(fn, ms)`**, built on React 19.3's `useEffectEvent`.
- Add three page hooks: **`useOpsSession`**, **`useOpsTabs`** and **`useLogFeed`**.
- Split MapView into six contiguous hooks: lifecycle, live feed, pointer, weather layers, ship layers, selection tracks. They read the map through the existing `useDashboardMap()`.
- Move about 20 pure helpers out of components into `lib`. Lazy-only ones go into lazy-only modules, which are pinned by `tests/first-screen-lazy.test.ts`.

---

## 1. Inventory — side effects, cleanup/race handling, embedded logic

Legend: ✓ = correct; ⚠ = issue (see §2); → = pure logic that should move to `lib` (see §3.3).

### 1.1 Dashboard `/` — first screen (static graph of `app/layout.tsx`, `app/page.tsx` and the error boundaries, plus the dynamic MapView)

| File (lines) | Side effects (file:line) | Cleanup / abort / races | Embedded logic → target |
|---|---|---|---|
| `components/MapView.tsx` (728) | **Mega-effect 158-421 with `[]` deps** (eslint-disable at 420). It does all of the following: creates the map (162-168) and calls `setDashboardMap` (169); runs a style-fallback timer (182) with `style.load`/`error` handlers (184-191); creates the Worker (195) and the WS client (197) and wires `worker.onmessage` (234); debounces `moveend` 300 ms (249-252); polls airports (268-273); builds the hover popup (285-342); starts the worker, connects the client and subscribes the viewport (346-348); polls KR radar (349) on a 60 s interval (351); runs the airports 60 s recheck/5 min refetch (352-356); on `load` adds layers, attribution, mousemove/mouseout/dragstart/click (358-393); listens to `visibilitychange` (395-399). Separate effects: SIGMET 30 s clock + rAF (424-429); SIGMET layer (432-449); prediction (452); RainViewer frames (455-468); RV coverage (471-488); KMA frames (492-525); flyTo (528-535); layer visibility (538-552); TrafficGridPoller (557-563); traffic draw + stale timeout (564-575); WS `setLayers` (578-581); ship 30 s clock (584-587); ships/grid draw (589-598); selected ship (601-610); category filter (613-618); WS `selectShip` (621); **ship track REST** (624-653, fetch at 648); live extension (655-670); AIS gap merge (673-679); AIS coverage (682-692); **aircraft select + track REST** (695-714, fetch at 710); live extension (716-725). | ✓ Unmount cleanup is complete: listeners, timers, rAF, popup, WS, worker, map and store (401-419). ✓ Track fetches use `cancelled` flags and stale checks (636-652, 703-713), but there is no `AbortController`. ⚠ The KR and airport polls have no in-flight or out-of-order guard and no visible-resume (B9). ⚠ The applied-data caches are not tied to the map instance (B8). ⚠ `TrafficGridPoller.stop` leaves a request in flight (B6). Module-level helpers that read the store live inside the component file: `shipPos` 56, `publishShipTrack` 64, `drawShipTrack` 71, `shipLabel` 77, `syncFrames` 89, `geo` 102. | → aircraft feature mapping (221-231); airport stale + key (262-263); layer pick priority (276-282); tooltip dispatch per layer (303-334); click → action (373-392); SIGMET "inside" set + key (435-447); radar/KMA frame specs (459-466, 508-515). |
| `components/StatusBar.tsx` (266) | 13 store selectors (34-46) and `useNow(1000)` (47). `useOverflow` (102-152) uses a layout effect, ResizeObserver, rAF and `flushSync`. Document key/pointer/focus listeners are attached while the details panel is open (171-199). | ✓ All cleaned up; good design. The display model is already in `lib/statusbar`. | none (well split already) |
| `components/AlertPanel.tsx` (167) | 6 selectors plus `useRxFresh` (23-32); `EventBanner` uses `useNow(1000)` (125); **each `EtaBadge` uses `useServerNow(1000)`** (159). | ✓ No async work. ⚠ The 1 Hz re-render covers every PREDICTED row, even while the panel is hidden (P1). | → region filter and sort (37-49) to `lib/alerts.alertsInScope`. |
| `components/AircraftSearch.tsx` (294) | Window `keydown` for "/" (74-83). Debounced dual search (86-108) with **AbortController** ✓. `chooseAircraft` (110-124) awaits `apiGet` (117). `chooseShip` (126-137) toggles the layer and writes prefs (130). `useServerNow(1000)` at top level (69). | ✓ Search requests are aborted on a new query (pinned by `search-ships-mount.test.ts`). ⚠ The `chooseAircraft` continuation is not tied to the latest choice (B3). ⚠ The header re-renders at 1 Hz even when the results are closed (P5). | → `failText` (36-41) and `shipRows` (44-47) to `lib/search`. Note that `shipRows` is computed twice per render (142, 247). |
| `components/LayerPanel.tsx` (91) | Mount effect reads `localStorage` directly (39) and the prefs (41-44); `flip` writes `localStorage` directly (62). | ✓ Wrapped in try/catch. ⚠ This bypasses `lib/prefs`, unlike layers and ship categories. | → legend key read/write to `lib/prefs`. |
| `components/MapChips.tsx` (76) | 7 selectors and **two 1 s clocks** (46-55). `chipFilter` reads the mutable `shipStates` during render (34-42). | ⚠ The `aria-live` container text includes live counts (B7). | ok (`lib/demand`, `lib/ships` hold the logic) |
| `components/MapLegend.tsx` (278) | 4 selectors (115-122). The selector at 120 builds GeoJSON (`aisCoverageFeatures`) on **every store emit** just to compute a boolean. | ✓ | → `memo` on `ais.coverage` (P6) |
| `components/RadarTimeline.tsx` (101) | Animation interval of 600 ms (43-51) and a 30 s clock (55). | ✓ Cleanup present. ⚠ The `radarKr?.frames.length` read at 54 assumes the REST shape (B10). | → `krUnavailableText` (15-19) to `lib/kr-radar`. |
| `components/SidePanel.tsx` (39) | Keeps `AlertPanel` mounted and `hidden` while other tabs are shown (30), which preserves state. | Clock subscriptions keep running while hidden (P1). | — |
| `components/Shell.tsx` (57) | `installErrorReporter` (23). | ✓ Returns the uninstaller. | — |
| `components/DashboardParts.tsx` (69) | Idle prefetch (51-68). | Not cancellable, which is harmless. | — |
| `components/LazyPart.tsx` (205) | Focus after retry (117-128); chunk probe in `componentDidCatch` (173-183). | ✓ `mounted` flag; the probe has a timeout. | — |

### 1.2 Dashboard — lazy parts (`components/DashboardParts.tsx`; not on the first screen)

| File | Side effects | Cleanup / races | Embedded logic → target |
|---|---|---|---|
| `components/AircraftCard.tsx` (258) | **30 s interval** (175-178); detail `apiGet` (179-185); 1 s clocks (170-171); render-time read of `aircraftStates` (191). | ✓ `live` flag; error and detail keyed by hex (165, 187-188). ⚠ No `AbortController`. ⚠ No in-flight guard, so an answer slower than 30 s is always dropped by the next refresh (B9). ⚠ Keeps polling while hidden (B12). | → `newerState` (41-45), `qualityLabel` (47-52), `REASON_LABEL`, `EMERGENCY_SQUAWKS` to a new lazy-only `lib/aircraft-card.ts`. |
| `components/ShipCard.tsx` (325) | Detail `apiGet` (69-77) that refetches when WS reports the ship gone (68); `ShipList` combines a 1 s clock (292), a per-render full filter and two full sorts (305-308), and a re-render on each `ships.version` (284). | ✓ `alive` flag, keyed by mmsi, skip rule pinned by `search-ships-mount.test.ts:77-99`. ⚠ No abort. ⚠ `ShipList` cost (P2). | → `parseShipDetail` (32-46), `isoOrNull` (29) to `lib/ship-card.ts`. `newer` (49-53) is an exact copy of `newerLite` in `lib/ships.ts:318`; reuse it. |
| `components/AirportCard.tsx` (80) | `apiGet` wx (35-39); `useNow(30 s)` (34). | ✓ `live` flag. ⚠ The error is not keyed (B5). ⚠ The link is not encoded (48, B11). | — |
| `components/AirportList.tsx` (61) | `apiGet` once on mount (17-23). | ✓ `live` flag. The valid-feature filter (20) duplicates `MapView.tsx:271`. | → the per-row category/stale/colour derivation and sort (30-41) to `lib/format`. |
| `components/SigmetCard.tsx` (102) | `apiGet` "inside" list (25-31). | ✓ `live` flag, keyed by id. | → `InsideAircraftList` merge (75-78) can stay. |
| `components/SigmetList.tsx`, `EvidenceCard.tsx`, `KrRadarPanel.tsx`, `ShipTable.tsx`, `PortCallsSection.tsx` | Selectors and clocks only. | ✓ | — |
| `components/ReceptionLayer.tsx` (87) | `EtagPoller` start/stop (37-41); layer tooltip registration (43); draw (46-54); hide on leave (56-65); derived store write `receptionInView` (73-76). | ✓ Well structured. ⚠ `stop()` does not cancel the in-flight request (B6). | — |

### 1.3 Other routes

| File | Side effects | Cleanup / races | Embedded logic → target |
|---|---|---|---|
| `app/ops/page.tsx` (464) | Session check (146). Tab `reload` with `RequestOrder` (197-229, `apiGet` at 206). First load (232) and **15 s interval** (233). `fail` and `authMiss` probes (183-192). Logout DELETE (259). **Provider toggle POST** (263-265). **Settings PUT** (400-417). | ✓ `RequestOrder` is a good model: barrier requests, and slow answers are not dropped (`tests/ops-request-order.test.ts`). ⚠ B2, B4, B11, B12, B15. | → `TAB_PATH`/`tabPath` (44-49) to `lib/endpoints/ops`; `at()` (55). |
| `app/logs/page.tsx` (21) | Session check (16), a duplicate of ops (146). | ⚠ B15 | → `useOpsSession` |
| `components/logs/LogsDashboard.tsx` (509) | `load` guarded by `loadSeq` (108-132); deferred first load (135-139); **auto-check** (142-165) and **interval** (166-170); `openById` (172-184); initial `#id` open (186-190); `hashchange` (192-204); `scrollIntoView` (207); copy/download (212-232, `apiGet` at 229); **`loadMore`** (238-248); resolve re-read with `rereadSeq` (296-326). | ✓ `loadSeq` and `rereadSeq` are good. ⚠ B1, B12, B13, B14. | → `groupsSig` (38), `initialState` (54-58), and the `{item}` unwrapping that is duplicated at 176 and 317, to `lib/logs`. |
| `components/logs/LogDetail.tsx` (160) | Related-by-request-id fetch (50-57) and fingerprint stats (59-66). | ✓ `live` flags; remounts per entry (`key={entryKey}`). No abort. | — |
| `components/logs/AisGapsTable.tsx` (69) | `apiGet` per period or refresh (22-29). | ✓ `live` flag. ⚠ The error is not keyed by period (B17). | — |
| `components/OpsRunsDrill.tsx` (98) | Load guarded by `seq` (34-54); deferred initial load (57-60); latest-callback ref (32-33). | ✓ This is the reference pattern for "drop stale answers". | — |
| `components/ResolveConfirm.tsx` (192) | `useResolveSlot` focus restore (47-52); `run` via `apiSend` (115, 126) with `busy` and `live` refs. | ✓ Double-submit is already guarded here. | — |
| `components/OpsLogin.tsx` (44) | Submit (22); focus timeout (23). | ✓ (`busy`) | — |
| `app/stats/page.tsx` (164) | `useLoad` (98-111) ×4 panels; `openedAt` uses `Date.now` in a `useState` initializer (36). | ✓ **The keyed result `{key, load}` drops stale answers without a synchronous setState in the effect.** This is the template for `useApiResource`. No abort. | → `top()` (46), `flagOf` (86-88), `zoneBad` (90-92) to `lib/stats` / `lib/chart`. |
| `app/airports/[icao]/page.tsx` (75) | `apiGet` (32). | No `live` flag or abort, `err` is never cleared, and there is no loading status (B17). Safe today only because a param change remounts the segment (layout-router). | — |
| `app/replay/page.tsx` (132) + `components/ReplayMap.tsx` (132) | `ReplayLoader` life cycle (46-53; `lib/replay.ts:345+`, debounce, supersede and **abort on dispose**); play interval (55-59); initial range (37); ReplayMap map lifecycle (28-91), frame (92-112) and radar (115-130). | ✓ Already the target shape: a React-free loader plus a thin effect. ReplayMap captures `onBbox` once (eslint-disable at 90). The parent passes a stable callback; `useEffectEvent` would remove the disable. | — |
| `components/guide/GuideToc.tsx` (123) | Scroll/resize listeners plus rAF (44-66); `history.replaceState` (81). | ✓ | — |
| `components/logs/ErrorScreen.tsx` (100) | Report once (52-63). | ✓ `live` flag | — |

### 1.4 React-free side-effect modules in `lib` (already good; keep)

- `lib/ws.ts` `WakelineWsClient`: injectable socket, clock and reporter; validated messages; resync gates.
- `lib/replay.ts` `ReplayLoader`.
- `lib/ops.ts` `RequestOrder`.
- `lib/clock.ts`: one timer per period, shared by `useSyncExternalStore`.
- `lib/map-ready.ts`: `useDashboardMap`, `onReady`, layer tooltips.
- `lib/errorReport.ts`: rate-limited.
- `lib/chunk-probe.ts`: timeout.
- `lib/prefs.ts`: try/catch.
- `lib/copy.ts`: injectable env.
- `lib/etag-poller.ts`: good, apart from B6.

**Pattern summary:** 11 hand-written fetch effects use a `live`/`alive`/`cancelled` flag: AircraftCard, ShipCard, AirportCard, AirportList, SigmetCard, AisGapsTable, LogDetail ×2, the stats `useLoad`, and the two MapView track fetches. The airport history page has no flag at all. That flag is correct for unmount and prop change, but none of them aborts, and none has an in-flight guard for periodic refresh. Only search and replay use `AbortController`. There are three different stale-drop mechanisms: the flag, `seq`/`RequestOrder`, and the keyed result. The keyed result plus abort, from stats `useLoad`, is the one to standardise on.

---

## 2. Bugs and risks — evidence, root cause, minimal fix

**Test utilities already in the repo:**

- Vitest runs in the `node` environment. **There is no jsdom or happy-dom, and no Testing Library.**
- `tests/helpers/mini-dom.ts` provides just enough DOM for `react-dom/client` plus `React.act`. Events are fired by calling `__reactProps$…` handlers, or by dispatching on the root container (see `search-ships-mount.test.ts:62-64`).
- `renderToStaticMarkup` plus `tests/helpers/html-tree.ts` cover SSR-structure tests.
- `FakeMap` (`tests/helpers/fake-maplibre.ts`) and `FakeSocket` (`tests/helpers/fake-ws.ts`) stand in for MapLibre and the WebSocket.
- Network is faked with `vi.stubGlobal("fetch", …)` (15 files) or `vi.mock("@/lib/api")` (7 files).
- Fake timers are used with `toFake: ["setInterval","clearInterval","Date"]`.

All repros below use these utilities; the code is in Appendix A.

### B1 (Med) — Logs: a double "이전 항목 더 보기" appends one page twice — **REPRODUCED**

- **Evidence:** `components/logs/LogsDashboard.tsx:238-248`. `loadMore` reads `page.nextCursor`, awaits, then always calls `setPage(prev => appendLogPage(prev, p))`. The button at line 480 is never disabled.
  - `appendLogPage` de-duplicates items (`lib/logs.ts:139-150`) but **adds** `pages`, `invalid`, `serverInvalid` and `hiddenResolved`.
  - Repro output: `expected '해결 처리로 숨김 8건(불러온 3쪽 합계)' to be '해결 처리로 숨김 5건(불러온 2쪽 합계)'`. The "형식 오류로 건너뜀" sums are doubled the same way.
- **Root cause:** the append is not tied to the cursor it was requested for, and nothing guards a second in-flight request for the same cursor.
- **Fix (minimal):**

  ```ts
  const moreFor = useRef<string | null>(null);
  const loadMore = async () => {
    const cursor = page?.nextCursor;
    if (!cursor || moreFor.current === cursor) return;      // that page is already on its way
    moreFor.current = cursor;
    const my = loadSeq.current;
    try {
      const p = parseLogPage(await apiGet<unknown>(logsUrl(filter, page!.at, { cursor })));
      if (my !== loadSeq.current) return;
      setPage((prev) => (prev && prev.nextCursor === cursor ? { ...appendLogPage(prev, p), at: prev.at } : prev));
    } catch (e) { fail(e); } finally { if (moreFor.current === cursor) moreFor.current = null; }
  };
  ```

  Also add a `loadingMore` state: `disabled` and `aria-busy` on the button.
- **Test location:** append to `tests/logs-page-v5.test.ts`, next to the existing single-click test at line 204.

### B2 (Med) — Ops settings: a double save sends 2 PUTs and ends on a false conflict — **REPRODUCED**

- **Evidence:** `app/ops/page.tsx:400-417` has no in-flight state, and the button at 440 stays enabled while the PUT is pending. The repro produces 2 PUTs. With the server's 200 then 409, the final DOM shows `region_poll_s: 편집하는 동안 다른 곳에서 바뀌었습니다 …` and no success line.
- `toggle` (263-265) has the same problem: two POSTs and two audit rows.
- **Root cause:** a non-idempotent write (the If-Match version is consumed) has no busy guard.
- **Fix:** keep a per-key `saving` ref for same-frame clicks plus state for `disabled={… || saving.has(s.key)}`. Apply the same to `toggle`, keyed by provider name. The repo already has this pattern in `ResolveConfirm.tsx:89-93,107-109` (`busy` ref + `sending` state).
- **Test location:** `tests/ops-page.test.ts`.

### B3 (Med) — Search: a stale aircraft choice moves the map — **REPRODUCED**

- **Evidence:** `components/AircraftSearch.tsx:110-124`. When the hit has no live position and no `aircraftStates` entry, the code awaits `apiGet('/api/v1/aircraft/{hex}')` and then unconditionally calls `requestFlyTo(...)` and `setMsg(...)`.
  - Repro: choose A (DB-only), reopen, choose B (live), then resolve A's detail. The result is `selectedHex = 'bbbbbb'` but `flyTo = { lon: 20, lat: 10, id: 2 }`, which is A's position.
- **Root cause:** the async continuation is not tied to the latest choice.
- **Fix:** add `const choice = useRef(0)`. Each choice (aircraft or ship) does `const my = ++choice.current`. After the await, `if (my !== choice.current) return;`. Optionally abort the superseded detail request.
- **Test location:** a new `tests/search-choice.test.ts`; the repro already uses the `fetch` stub style.

### B4 (Med) — Ops: a write failure disappears at the next periodic reload — **REPRODUCED**

- **Evidence:** `reload()` starts with `if (!only) setErr(null)` (`app/ops/page.tsx:198`). The 15 s interval calls `reload(undefined, true)` (233). `toggle` reports failures through `fail → setErr` (264).
  - Repro: after a failed "disable" (500), the alert shows "switch store unavailable". After `advanceTimersByTime(15_000)` the alert text is `''`.
  - An operator who looks away for 15 s can miss that a provider was **not** switched off. The table still shows the old state, but nothing says the action failed.
- **Root cause:** one `err` slot is used both for "last write/session failure" and for "cleared on refresh". The periodic reload counts as a refresh.
- **Fix:** clear `err` only for a user-initiated full reload (`if (!only && !periodic)`), or move write failures to their own `writeErr` that is cleared by the next write or a dismiss button. The owner should decide which rule they want; the test pins whichever is chosen.

### B5 (Low-Med) — AirportCard shows the previous airport's error — **REPRODUCED**

- **Evidence:** `components/AirportCard.tsx:32` is `const [err, setErr] = useState<unknown>(null)`, with no icao, while `wx` is checked with `wx.airport.icao === icao` (40).
  - Repro output: `"Airport · RKSS이력닫기wx store unavailable(HTTP 503)요청 idfeedface0000beef복사로그 보기"`. RKSI's request id, and the `/logs#rid=` link that filters by it, are shown on RKSS's card.
- **Root cause:** inconsistent keying. `AircraftCard` (165, 188) and `ShipCard` (63, 79) key errors by id.
- **Fix:** `useState<{ icao: string; error: unknown } | null>` and read it only when `err.icao === icao`. Later this is subsumed by `useApiResource`, which keys by construction.

### B6 (Low-Med) — `EtagPoller` publishes after `stop()` — **REPRODUCED** (2 tests)

- **Evidence:** `lib/etag-poller.ts:58-63`. `stop()` clears the timer and the visibility watcher. `poll()` (65-84) awaits `fetcher` and then always calls `this.set()` → `publish()`. The repro shows:
  - `published` is non-empty after `stop()`.
  - In a stop-then-start sequence (layer off, then on), the stopped poller's late `"v1"` overwrites the new poller's `"v2"` in the store.
- **Users:** traffic grid (`MapView.tsx:558-563`) and reception (`ReceptionLayer.tsx:37-41`). When the layer is turned off then on, the store can hold the older poller's state, including an `error`, until the next poll (90-120 s).
- **Root cause:** the poller's lifetime is not part of the request's identity.
- **Fix:**
  - Add `private gen = 0; private ctl: AbortController | null`.
  - `stop()` does `gen++`, `ctl?.abort()`, `inflight = false`.
  - `poll()` captures `gen` and passes `signal: ctl.signal` in `init` (the `Fetcher` type already accepts `init`). It returns without `set()` if `gen !== this.gen`, checking both after `fetcher()` and after `res.json()`.
  - Existing tests are in `tests/traffic-grid.test.ts:207+` and `tests/reception.test.ts:286`. Add the two repro tests.

### B7 (Low-Med, a11y) — the map-chip live region announces counts — **REPRODUCED**

- **Evidence:** `components/MapChips.tsx:64` puts `aria-live="polite"` on the container. The ship chip text is ``선박 ${n0(v.count)}척 · 화면 안 · AIS`` (`lib/ships.ts:1167`), and the server fans out ships every ≥ 10 s (`ShipFanout.java:84 MIN_INTERVAL_MS = 10_000`).
  - Repro: the count changing from 120 to 121 changes the live region text, so a screen reader re-announces it.
  - The focus chip's "N분째" also changes every minute while an aircraft is selected.
- **Root cause:** the live region wraps values, not state transitions.
- **Fix:** remove `aria-live` from the container. `BasemapNotice` already has `role="status"`. Add an sr-only `role="status"` whose text is derived only from transitions: ship mode (points, grid, waiting, zero-reason) and warn on or off.
- This is a UX decision for the owner; the test pins whichever rule is chosen.

### B8 (Low; dev today, production if `cacheComponents` is ever enabled) — MapView caches outlive their map — **REPRODUCED** (StrictMode)

- **Evidence:** `sigmetApplied` (151) skips re-applying when `fc` and `key` are unchanged (441-442). `coverageKey` (682-692) does the same. Neither is reset when the map effect's cleanup removes the map (401-419).
  - Repro: with SIGMETs already in the store (as when returning to `/`), render `<StrictMode><MapView/></StrictMode>`. Two maps are created; on the surviving map, `getSource("sigmets").data.features` has length **0**.
  - SIGMETs come back only when the WS sends a new collection.
  - The AIS coverage outline never comes back until the coverage geometry changes. `parseAisStatus` creates new objects, but the JSON key is identical.
  - `coverageHost` (471), `krCoordsKey` (492), `radarLayers` (118) and `krLayers` (129) have the same "state of *this* map" meaning and survive too.
- **Root cause:** a cache of "what is drawn on the map" is keyed by data only, not by map instance.
- **Fix:** reset these refs in the map effect's cleanup. Better, move them into the layer hooks (§3.2), where they are keyed by `map`.
- Add a `strict` option to the mount helpers in `mapview-*` tests, because StrictMode is what `next dev` runs.

### B9 (Low) — Unguarded polls: KR radar, airports, AircraftCard — **REPRODUCED** (stacking)

- **Evidence:** `pollKr` (349) runs every 60 s (351) without checking whether the previous request settled.
  - Repro: with requests hanging, there are **6** `/api/v1/radar/kr` requests in flight after 5 min.
  - Nothing prevents an older, slower answer from overwriting a newer `radarKr`.
  - There is no refresh when the tab becomes visible again, unlike `EtagPoller.watch`.
  - The airports poll (268-273, 352-356) and `AircraftCard` (175-185) use the same pattern. For AircraftCard, each refresh flips `live=false` on the previous request, so a detail endpoint slower than 30 s never updates the card.
- **Mitigation present:** through the edge, an upstream hang is cut at 30 s (`infra/edge/nginx.conf:71 proxy_read_timeout 30s`), so stacking needs a client-side network stall or `next dev` (which rewrites directly to the API).
- **Fix:**
  - Reuse `EtagPoller` (after B6) for `/api/v1/radar/kr` and the watched airports. It has an in-flight guard, hidden-tab skip and visible-resume, keeps the last value on error, and copes with responses without an ETag (`same` stays false).
  - For the card, use `useApiResource(..., {refreshMs})` with an in-flight guard (§3.2).

### B10 (Low) — Unvalidated REST bodies can take down the dashboard — **REPRODUCED**

- **Evidence:** `apiGet<KrRadar>("/api/v1/radar/kr").then((d) => setData({ radarKr: d }))` at `MapView.tsx:349` is a cast, not a parse.
  - `RadarTimeline.tsx:54` evaluates `radarKr?.frames.length` on every render where `available` is truthy. A 200 body `{available:true, latest_tm:…}` without `frames` throws `TypeError: Cannot read properties of undefined (reading 'length')`, and the route error boundary replaces the dashboard.
  - WS messages, by contrast, go through `lib/ws-validate.ts` (504 lines), and other REST bodies are parsed: `parseShipDetail`, `parseSearchResponse`, `parseLogPage`, `parseTrafficGrid`, `parseReception`.
  - The same class applies to `Wx` (`AirportCard.tsx:40` `wx.airport.icao`; the airport page at 43 and 61) and to `Detail` (AircraftCard).
- **Fix:** `parseKrRadar(v): KrRadar | null` in `lib/kr-radar.ts` (and `parseWx`). On a mismatch, keep the last value and record an error. Put it in the endpoint function (§3.1).

### B11 (Low, hygiene) — unencoded path params

- `app/ops/page.tsx:264`: `apiSend("POST", `/api/v1/ops/providers/${name}/${action}`)` is an authenticated write carrying the CSRF header. `name` comes from `prov.providers[].name`.
- `:407`: `` `/api/v1/ops/settings/${k}` `` (PUT).
- `components/AirportCard.tsx:48`: `` <Link href={`/airports/${icao}`}> ``. `icao` comes from map-feature properties, which come from the server.
- All values are server-controlled, so exploiting this needs a compromised backend value. Still, a `/`, `?`, `#` or `..` in a provider name would redirect a CSRF-bearing write. `lib/logs.logItemUrl`, `replayApiPath` and the other fetches already encode.
- **Fix:** do `encodeURIComponent` inside the endpoint functions (§3.1), with unit tests asserting `/api/v1/ops/providers/a%2Fb/enable`.

### B12–B17 (Low) — inspection findings, each with a test approach

- **B12, polls in hidden tabs.**
  - Sites: AircraftCard 30 s (175-178), Ops 15 s × 7 endpoints (231-235), Logs 15 s (166-170). The WS client, the worker and EtagPoller do pause.
  - Test: set `dom.document.hidden = true` (mini-dom supports it), advance 60 s, and assert the fetch count.
  - Fix: `useVisibleInterval` (§3.2), with an immediate refresh when the tab is shown again.
  - This is a behaviour change; confirm with the owner that operators don't rely on background refresh.
- **B13, logs interval re-armed.**
  - `poll` depends on `page` and `groups` (165), so the interval effect (166-170) is cleared and recreated after every load, show-pending, load-more or empty-list poll. User actions postpone the 15 s check.
  - Test: fake timers; call load-more at t = 10 s and assert a poll still happens at t = 15 s.
  - Fix: `useVisibleInterval` with a `useEffectEvent` callback.
- **B14, `openById` without a seq guard** (172-184).
  - Test: two hash links in a row, with the first response delayed; assert the second item stays open.
  - Fix: a seq ref, as `rereadSeq` already does at 296.
- **B15, session check.**
  - `apiGet(OPS_SESSION_PATH).then(setMe).catch(() => setMe(null))` (`app/ops/page.tsx:146`, `app/logs/page.tsx:16`): a 500 or network error shows the login form.
  - Fix: `useOpsSession`, where 401/404 means login, any other error shows an error with retry, and an `AbortController` is used. Both pages share it.
- **B16, transport.**
  - `lib/api.ts:3` merges headers with `{ ...(init?.headers ?? {}) }`, which drops a `Headers` instance. No REST call has a timeout.
  - Fix: `new Headers(init?.headers)`. Optionally add a default timeout composed with the caller's signal; `lib/chunk-probe.ts:46-51` already shows the pattern.
- **B17, error and loading state.**
  - `AisGapsTable` keeps the previous period's error while the new period loads.
  - The airport history page renders nothing while loading and never clears `err`.
  - Both are fixed by `useApiResource`.

**Accessibility notes (not bugs):**

- Tabs are `aria-pressed` toggle buttons (SidePanel 25-27, Ops 274-279, Logs 332-335) rather than the ARIA tabs pattern. That is acceptable, but there is no arrow-key navigation or `tabpanel` association.
- There are no automated a11y checks. Playwright 1.63's built-in `toMatchAriaSnapshot` would pin roles and names on key screens without a new dependency.

---

## 3. Target structure

### 3.1 API client — `lib/endpoints/*` on top of `lib/api.ts`

**Why `lib/endpoints/` and not `lib/api/`:**

- Seven test files `vi.mock("@/lib/api")`: `mapview-lifecycle`, `mapview-ships-v5`, `mapview-traffic-grid`, `reception-wiring`, `dashboard-controls`, `search-ships-mount` and `search-ship-table-unloaded`.
- Endpoint modules that import `apiGet`/`apiSend` **from `@/lib/api`** stay intercepted by those mocks, because vitest mocks by resolved file.
- If `lib/api.ts` became `lib/api/index.ts` and endpoints imported `./http`, those mocks would stop intercepting. A `lib/api/` directory next to `lib/api.ts` also resolves ambiguously for readers.
- Endpoint functions must not touch other `@/lib/api` exports at module-evaluation time; the mocks only define `apiGet`.

**Rules:**

- One small module per area.
- Each function is typed, accepts `{ signal?: AbortSignal }`, **encodes every path param**, reuses the existing builders (`logsUrl`, `runsDrillPath`, `replayApiPath`, `resolutionPath`, `OPS_SESSION_PATH`) and returns **parsed** data wherever a parser exists.
- Heavy parsers used only by lazy cards stay in lazy-only modules. The endpoint returns `unknown` for those, or the endpoint itself lives in a lazy-only module.
- No caching layer and no classes.
- Conditional GETs (304), the keepalive error report and the HEAD chunk probe keep their own transport: `EtagPoller`, `errorReport`, `chunk-probe`.

| Module | Functions (path) | Callers today | First screen? |
|---|---|---|---|
| `lib/endpoints/aircraft.ts` | `aircraftDetail(hex)` → `/api/v1/aircraft/{hex}`; `aircraftTrack(hex)` → `/…/{hex}/track` (→ `trackFromRest`); `searchAircraft(q)` → `/api/v1/aircraft/search?q=` (→ `parseSearchResponse`) | AircraftCard:181, AircraftSearch:93,117, MapView:710 | yes (search, map); tiny |
| `lib/endpoints/ships.ts` | `shipTrack(mmsi, fromMs, toMs)` (→ `shipTrackFromRest`); `searchShips(q)` → `{hits, dbUnavailable}` | MapView:648, AircraftSearch:99 | yes |
| `lib/endpoints/ship-detail.ts` | `shipDetail(mmsi)` → `parseShipDetail` (moved to `lib/ship-card.ts`) | ShipCard:73 | **no**; add to `CARRIED_BY_PARTS` in `tests/first-screen-lazy.test.ts` |
| `lib/endpoints/weather.ts` | `krRadar()` (+ `parseKrRadar`, B10); `watchedAirports()` (the valid-feature filter now duplicated at MapView:271 and AirportList:20); `airportWx(icao)` (+ `parseWx`); `sigmetInside(id)` → `string[] \| null` | MapView:270,349, AirportList:19, AirportCard:37, airports page:32, SigmetCard:27 | yes (map) |
| `lib/endpoints/stats.ts` | `sigmetStats(group)`, `alertStats()`, `trafficStats(day)` (exact current URLs) | stats page:32-40 | no |
| `lib/endpoints/replay.ts` | `replayFrame(req, signal)` (uses `replayApiPath`) | replay page:48 | no |
| `lib/endpoints/ops.ts` | `opsSession()`, `signIn(u, p)`, `signOutRequest()`, `opsTab(tab, runsMode)` (moves `TAB_PATH`/`tabPath`), `setProviderEnabled(name, on)` (encoded), `saveSetting(key, value, version)` (encoded, If-Match), `runsDrill(k, since, cursor)`, `createResolution(draft, note)`, `revokeResolution(id)` | ops page:146,206,259,264,407, OpsLogin:22, OpsRunsDrill:38, ResolveConfirm:115,126 | no |
| `lib/endpoints/logs.ts` | `logsPage(filter, at, opts)`, `logGroups(filter, at)`, `logItem(id, stream)` (+ `parseLogItemResponse`, the `{item}` unwrapping duplicated at LogsDashboard:176/317), `aisGaps(fromIso)` | LogsDashboard (8 sites), LogDetail:53,62, AisGapsTable:25 | no |

**Pinned by existing tests:**

- `mapview-lifecycle.test.ts` asserts `"/api/v1/radar/kr"` and `"/api/v1/airports?watched=true"`.
- `stats-states.test.ts` asserts the four stats URLs.
- `search-ships-mount.test.ts` asserts `"/api/v1/aircraft/search?q=SYNA"` and `"/api/v1/ships/search?q=SYN%20A&limit=10"`, plus abort signals.
- `ops-runs-drill.test.ts` asserts the drill URLs.
- `logs-page-v5.test.ts` asserts `logsUrl(...)`.
- `ops-page.test.ts` and `resolve-*.test.ts` assert the ops and resolutions paths.

**New tests:** `tests/endpoints.test.ts` for encoding, signal pass-through and parse-on-mismatch.

**Not justified: react-query, SWR or similar.**

- There are about 20 call sites, a custom WS store already owns live data, and the first-screen budget has about 6.4 KB headroom.
- A query library is several KB gzip on the first screen (search and map), and its cache would duplicate `lib/store`.
- The in-repo primitives (`useLoad`, `RequestOrder`, `ReplayLoader`, `EtagPoller`) already cover the needs.

### 3.2 Custom hooks (minimal set)

**Constraints from the repo's lint**, verified with `eslint --print-config`. These rules are errors: `react-hooks/set-state-in-effect`, `refs`, `purity`, `immutability`, `globals`, `set-state-in-render`. So the hooks:

- never call setState synchronously in an effect body, and represent "loading" by **keyed results** (the stats `useLoad` trick);
- read refs only in callbacks;
- use React 19.3's `useEffectEvent` for "latest callback" (verified: `typeof React.useEffectEvent === "function"`; eslint-plugin-react-hooks 7.1.1 understands it).

| Hook | Inputs → outputs | Users | Code that moves into it |
|---|---|---|---|
| **`useApiResource<T>`** (`lib/use-api-resource.ts`) | `(key: string \| null, load: (signal) => Promise<T>, opts?: { refreshMs?: number })` → `{ status: "idle"\|"loading"\|"loaded"\|"failed", data: T \| null, error: unknown, retry(): void }`. Semantics: the result is stored as `{key, data, error}` and returned **only for the current key**, which fixes B5 and B17 by construction. A key change aborts the previous request. `retry` re-requests. Refresh keeps `data`, skips while a request is in flight (no stacking or starvation, B9), and skips hidden tabs (B12). Answers are applied only for the current key and generation. | stats panels ×4 (replaces `useLoad`), AirportCard, airport page, AirportList, SigmetCard, AisGapsTable, AircraftCard (`refreshMs: 30_000`), LogDetail ×2 | `app/stats/page.tsx:98-111`, `AirportCard.tsx:30-39`, `app/airports/[icao]/page.tsx:29-32`, `AirportList.tsx:14-23`, `SigmetCard.tsx:22-31`, `AisGapsTable.tsx:19-29`, `AircraftCard.tsx:164-188`, `LogDetail.tsx:38-66` |
| **`useVisibleInterval`** (`lib/use-visible-interval.ts`) | `(fn, ms: number \| null, { onVisible?: boolean })` → void. `fn` is wrapped in `useEffectEvent`, so the interval is not reset when `fn` changes (fixes B13). Ticks are skipped while `document.hidden`. It can run once when the tab is shown again, reusing `watchVisible` from `lib/etag-poller.ts:15`. | OpsDashboard (15 s), LogsDashboard (15 s), `useApiResource` refresh, MapView airport recheck (60 s) | `app/ops/page.tsx:231-235`, `LogsDashboard.tsx:166-170`, `AircraftCard.tsx:175-178`, `MapView.tsx:353-356` |
| **`useOpsSession`** (`components/ops/useOpsSession.ts`) | `()` → `{ checked, me, notice, error, login(u), leave(note), retry() }`. 401/404 means the login form; anything else is an error with retry (B15). | app/ops/page, app/logs/page | `app/ops/page.tsx:143-150`, `app/logs/page.tsx:13-20` (identical today) |
| **`useOpsTabs`** (`components/ops/useOpsTabs.ts`) | `({ onLeave, onRuns(v, mode) })` → `{ data: {providers, runs, quality, settings, audit, dlq, pipeline}, setProviders, lastOk, tabErr, runsMode, toggleRunsMode(), reload(only?) }`. Keeps one `RequestOrder` per tab and the 15 s `useVisibleInterval` with periodic = non-barrier. | OpsDashboard | `app/ops/page.tsx:155-168, 176-241` (≈ 90 lines). Its ordering rules are already pinned by `ops-request-order`, `ops-page`, `resolve-ops-page`, `ops-runs-drill`, `ops-traffic-grid-fill` and `region-no-provider`. |
| **`useLogFeed`** (`components/logs/useLogFeed.ts`) | `(view, filter, { active, fail })` → `{ page, groups, freshGroups, pending, loading, loadingMore, lastOk, load(), loadMore(), showPending(), showFreshGroups(), setPage, setGroups }`. `loadSeq`, a per-cursor in-flight guard (B1) and the auto-check via `useVisibleInterval` (B13) live inside. | LogsDashboard | `LogsDashboard.tsx:76-92, 108-170, 233-248` |
| **MapView hooks** (`components/map/*.ts`, each reading the map through the existing `useDashboardMap()` from `lib/map-ready.ts`, already used by `ReceptionLayer`) | `useMapLifecycle(elRef, onFirstLoad)`: map, style fallback, attribution, `setDashboardMap`. `useLiveFeed(map)` → client: worker, WS, viewport subscribe, visibility, `applyRender`/prediction. `useMapPointer(map)`: hover and click via pure `lib/map-pointer.ts`. `useWeatherLayers(map)`: SIGMET, RainViewer, coverage, KMA, airports layer and its poll, KR poll via `EtagPoller`. `useShipLayers(map)`: ships, grid, selection, category filter, AIS coverage, traffic grid. `useSelectionTracks(map, client)`: aircraft and ship tracks, WS select/selectShip/setLayers. | MapView only | Contiguous blocks: 158-421 → lifecycle, live feed and pointer; 424-618 and 673-692 → layers; 621-670 and 695-725 → tracks. Layer caches move in with their effect and are keyed by `map` (B8). |

**Where extraction is NOT worth it:**

- `ShipCard`'s detail effect (`:69-77`). Its "refetch once on live→gone unless the loaded detail already says not-live" rule is stateful and pinned by `search-ships-mount.test.ts:77-99`. Keep the effect; only switch to `shipDetail()` with an AbortController.
- `StatusBar` (already `StatusBar`/`StatusBarView` plus `lib/statusbar`; `useOverflow` can stay local).
- `ReplayPage`/`ReplayLoader` (already the target shape).
- `ResolveConfirm`/`useResolveSlot`.
- `LazyPart`.
- `GuideToc` scroll-spy (single use, tidy).
- `ErrorScreen`.
- `RadarTimeline`'s 3-line animation interval.
- `LayerPanel`'s prefs effect: move only the `localStorage` access into `lib/prefs`.
- `OpsRunsDrill`: its `seq` pattern is fine.
- Presentational components: `KstTime`, `UnitStack`, `BarChart`, `ShipTable`, `PortCallsSection`, `OpsPipeline`, `AttributionFooter`, `AlertStatsTable`.
- Generic "newer by `seen_at`": AircraftCard's version uses `seenAtMs`, with epoch support, so only remove the exact ship duplicate.
- Wrapping `useServerData` selectors into named hooks per field adds indirection without behaviour.

### 3.3 Pure functions to move into `lib` (React-free, unit-testable)

| From | Function(s) | To | Note |
|---|---|---|---|
| MapView 221-231 | `aircraftFeatureCollection(states, selectedHex)` | `lib/maplayers.ts` | Runs at the worker tick (250 ms–4 s). |
| MapView 262-263 | `airportLayerFeatures(features, nowMs)` → `{features, key}` | `lib/format.ts` or `lib/airports.ts` | |
| MapView 276-282, 303-334, 373-392 | `pickByPriority(hits, PICK_LAYERS)`, `tipFor(layerId, props, ctx)`, `clickAction(feature, zoom)` | new `lib/map-pointer.ts` | Today these are covered only indirectly; add characterization tests first. |
| MapView 435-447 | `sigmetLayerData(sigmets, alerts, nowMs)` → `{fc, key}` | `lib/sigmet.ts` | |
| MapView 56-82, 89-100 | `shipPos`, `shipLabel`, `publishShipTrack`, `syncFrames` | `lib/ships.ts`, `lib/maplayers.ts` | |
| AircraftCard 35-52 | `newerState`, `qualityLabel`, `REASON_LABEL`, `EMERGENCY_SQUAWKS` | **new lazy-only** `lib/aircraft-card.ts` | Add to `CARRIED_BY_PARTS`. |
| ShipCard 29-53 | `parseShipDetail`, `isoOrNull`; `newer` → reuse `newerLite` | `lib/ship-card.ts` (already lazy-only) | `ships-v5` and `kst-hover` tests import `parseShipDetail` from `@/components/ShipCard`; update the imports or re-export. |
| AlertPanel 37-49 | `alertsInScope(alerts, scope, status)` | `lib/alerts.ts` | |
| AircraftSearch 36-47 | `searchFailText`, `shipRows` | `lib/search.ts` | |
| Stats 46, 86-92 | `topDims(rows, n)`, `flagOf`, `zoneBad` | `lib/chart.ts`, `lib/stats.ts` | |
| AirportList 30-41 | `airportListRows(features, now)` | `lib/format.ts` | |
| RadarTimeline 15-19 | `krUnavailableText` | `lib/kr-radar.ts` | |
| LogsDashboard 38, 54-58, 176/317 | `groupsSig`, `initialLogsState(hash)`, `parseLogItemResponse` | `lib/logs.ts` | |
| LayerPanel 39, 62 | `loadLegendOpen`, `saveLegendOpen` | `lib/prefs.ts` | |

**First-screen rule:** a helper moved out of a **lazy** component must not land in a module the first screen imports. Use the lazy-only modules (`lib/ship-card.ts`, a new `lib/aircraft-card.ts`) and list them in `tests/first-screen-lazy.test.ts` `CARRIED_BY_PARTS`, which fails if they become statically reachable from `/`.

### 3.4 Commit plan — each commit keeps eslint, tsc, vitest, `next build` and `check:first-js -- --in-image` green

Run `npm run build && npm run check:first-js -- --in-image` on every commit and record the byte delta in the commit message. Commits marked "behaviour change" need the owner's OK.

| # | Commit | Pinned by (existing) | New tests (failing first) |
|---|---|---|---|
| 0 | Baseline: record `--in-image` bytes; optionally add `tests/helpers/mount.ts` (createRoot/act/find/propsOf/settle, with an optional `<StrictMode>`), which deduplicates helpers repeated in about 24 files | all | — |
| 1 | fix(B6): `EtagPoller` generation + abort on `stop()` | `traffic-grid.test.ts:207+`, `reception.test.ts:286`, `mapview-traffic-grid`, `reception-wiring` | A.1 (2 tests) |
| 2 | fix(B1): logs load-more per-cursor guard + busy button | `logs-page-v5:204` | A.2 |
| 3 | fix(B2, B11-ops): settings/toggle in-flight guard; `encodeURIComponent(name/key)` | `ops-page`, `resolve-ops-page`, `errors-v5` (settings path) | A.3 + encoding assertions |
| 4 | fix(B4): periodic reload no longer clears write errors (rule chosen by the owner) | `ops-page` (R-12 tests) | A.4 |
| 5 | fix(B3): search choice token | `search-ships-mount`, `search-ship-table-unloaded`, `kst-hover` | A.5 |
| 6 | fix(B5, B11-link): AirportCard error keyed by icao; encoded `/airports/` link | `kst-hover`, `kst-pages`, `error-screens-v5` | A.6 |
| 7 | fix(B8): reset MapView map-scoped caches in map cleanup | `mapview-lifecycle`, `mapview-ships-v5`, `mapview-traffic-grid`, `reception-wiring` | A.7 (StrictMode) |
| 8 | fix(B9, B10): `parseKrRadar` + KR/airport polls via `EtagPoller` | `mapview-lifecycle` (asserts the URLs), `kma-*`, `review-v1-ui` | A.8, A.9 |
| 9 | refactor: `lib/endpoints/{aircraft,ships,weather}` + dashboard callers | `mapview-*`, `search-*`, `request-ids-ships-v5`, `ships-v5`, `kst-hover` | `endpoints.test.ts` (paths, encoding, signal) |
| 10 | refactor: `lib/endpoints/{stats,replay}` | `stats-states`, `replay-503`, `replay-slider`, `kst-replay` | — |
| 11 | refactor: `lib/endpoints/{ops,logs}` (+ `ship-detail`, lazy-only) | `ops-*`, `resolve-*`, `logs-*`, `error-screens-v5`, `first-screen-lazy` (add the module) | — |
| 12 | refactor: pure helpers out of ShipCard, AircraftCard, AlertPanel, AircraftSearch, Stats, AirportList, RadarTimeline, LogsDashboard, LayerPanel | the component tests above + `first-screen-lazy` | unit tests for each moved function (characterize with current inputs) |
| 13 | refactor: MapView pure helpers → `lib/map-pointer`, `maplayers`, `sigmet`, `ships` | `mapview-*`, `dashboard-controls`, `statusbar` | characterization tests for `tipFor`, `clickAction`, `pickByPriority`, `aircraftFeatureCollection`, `sigmetLayerData` |
| 14 | feat: `useApiResource`; migrate stats (`useLoad` → hook) | `stats-states` (exact panel states) | hook unit tests: key change resets and aborts, unmount aborts, retry, refresh keeps data, no refresh while in flight, hidden skip |
| 15 | migrate AirportCard, airport page, AirportList, SigmetCard, AisGapsTable, LogDetail | `kst-*`, `review-v1-ui`, `logs-page-v5` | characterization first for AirportList states and SigmetCard "inside" states (currently untested) |
| 16 | migrate AircraftCard (`refreshMs`) | `error-screens-v5:235`, `kst-dashboard`, `units-v5` | refresh-in-flight and hidden-tab tests (behaviour change B12) |
| 17 | feat: `useVisibleInterval`; Ops and Logs periodic via the hook (B12, B13) | `ops-page`, `logs-page-v5`, `logs-streams-v5` | hidden-tab skip, no re-arm on page change |
| 18 | feat: `useOpsSession` (B15) | session tests in `ops-page` and `logs-page-v5` | 500 on the session check → error + retry, not login |
| 19 | feat: `useOpsTabs` | `ops-request-order`, `ops-page`, `resolve-ops-page`, `ops-runs-drill`, `ops-traffic-grid-fill`, `region-no-provider` | — |
| 20 | feat: `useLogFeed` (+ B14 seq) | `logs-page-v5`, `logs-streams-v5`, `resolve-logs-page` | B14 ordering test |
| 21-24 | MapView split: pointer, then tracks, then layers, then live feed/lifecycle (one hook family per commit) | `mapview-lifecycle`, `mapview-ships-v5`, `mapview-traffic-grid`, `reception-wiring`, `request-ids-ships-v5`, `dashboard-controls`, `first-screen-js`, `parts-prefetch` | StrictMode variants of the lifecycle tests |
| 25 | a11y (B7, behaviour change): map-chip live region for transitions only | `ships-v5`, `ships-demand`, `dashboard-layout` | A.10 |
| 26+ | perf (optional, each with before/after from §4): AlertPanel `<Activity>`, ShipList memo, search clock only when open, MapLegend selector memo | the component tests | Profiler commit-count tests (deterministic) |

**Bundle risk** applies to MapView, which is in the counted "dynamic" group (`0cgk2l8vp6gl2.js` + `3ctvfjxkm6rwm.js`, 23.7 KiB gzip today), and to the search and map endpoint modules, which are in the entry group. Splitting into modules adds a small Turbopack wrapper per module. Keep the MapView hooks in one or two files if the delta exceeds about 0.5 KB.

---

## 4. Performance — hot spots, measured baseline, how to measure before/after

**Environment for every number in this section:** Node v24.3.0, Apple M1, React 19.3 **development** build inside vitest with the repo's mini-DOM, synthetic data. These are relative baselines, not browser timings.

- Production React is faster.
- Browser DOM, style and layout costs and MapLibre's work are **not** included.
- Probe code is in Appendix B.

| # | Hot spot | Trigger | Measured | Verdict / option (do only if a browser trace agrees) |
|---|---|---|---|---|
| P1 | **AlertPanel `EtaBadge` ×N**, one `useServerNow(1000)` per PREDICTED row; the panel stays mounted while hidden (`SidePanel.tsx:30`) | 1 Hz | React render per 1 s tick: **0.9 ms** (38 badges), **3.1 ms** (225), **2.5 ms** (525) | Small. The waste is rendering while hidden. Option: React 19.3 `<Activity mode={panel==="alerts" ? "visible" : "hidden"}>` around `AlertPanel`. It keeps state and DOM like `hidden` does, but unmounts effects, which includes the `useSyncExternalStore` clock subscription, so it renders 0 times while hidden. Pin with a Profiler test: "hidden ⇒ 0 commits over 10 s". |
| P2 | **ShipList** (ship tab, nothing selected): full `shipList` filter and sort, then `sortShipRows` re-sort of all ships, to show 50 rows (`ShipCard.tsx:305-308`) | every 1 s + every ships message | per tick: **0.36 / 1.37 / 3.15 ms** at 1k / 5k / 10k ships (name sort); **0.59 / 2.76 / 6.04 ms** (age sort) | Worth a `useMemo` on `[ships.version, q, shipCats, sort.key≠age]`, so only the age sort depends on `now`. This is one of the few clear wins; on low-end devices multiply by about 4–5. |
| P3 | MapView ships redraw `shipFeatures(all)` (`MapView.tsx:589-598`) | each ships message (≥ 10 s), 30 s stale tick, selection, category change | **0.30 / 1.01 / 2.25 ms** per call at 1k / 5k / 10k (`MAX_SHIPS=10_000`) | Main-thread JS is fine. MapLibre `setData` serialisation can only be measured in a browser. If a trace shows long tasks, use `GeoJSONSource.updateData` diffs; feature ids are already `mmsi`. |
| P4 | `applyRender` builds an aircraft FeatureCollection, then `refreshPrediction` (`MapView.tsx:217-238`) | worker tick 250 ms–4 s (`public/interpolate.worker.js` `tickIntervalMs`) | not measurable in node (outside React) | Measure in the browser: `performance.mark/measure` around `applyRender` under e2e WS injection. No change without numbers. |
| P5 | Always-mounted chrome on 1 s clocks: `StatusBar` (`useNow`), `AircraftSearch` **even when closed** (`:69`; `shipRows` twice per render 142/247), `MapChipsView` (two clocks) | 1 Hz | StatusBar: **0.08 ms/commit** | Cheap. Moving search's clock into the open results view is trivial; pin it with a render-count test. |
| P6 | Per-WS-diff store fan-out: `setData` per aircraft diff (`lib/ws.ts:515-519`) notifies about 45 selectors; `MapLegend.tsx:120` builds GeoJSON per emit | per diff | StatusBar per diff: **0.12 ms/commit** (50 diffs = 5.9 ms) | Fine. Memo the MapLegend selector. |

**How to measure before and after in this repo (no new dependencies):**

1. **Pure functions:** `vitest bench` is available (Vitest 5.0.2 with tinybench installed). Add `tests/perf/*.bench.ts` and run `npx vitest bench`. Bench files don't match `include: tests/**/*.test.ts`, so CI is unaffected. Appendix B is a ready probe.
2. **React work:** wrap the subtree in `<Profiler onRender>` in a mini-DOM test.
   - Drive it with fake timers (clock ticks), `setData` (WS-like updates) or the real `WakelineWsClient` + `FakeSocket` (`tests/helpers/fake-ws.ts`).
   - **Assert commit counts in CI**, which is deterministic: for example, "AlertPanel hidden ⇒ 0 commits", "closed search ⇒ 0 commits per tick", "ShipList recomputes once per ships version".
   - Print `actualDuration` for information only. Timing thresholds are flaky in CI.
3. **Browser:** a Playwright spec on the fixture stack, reusing the injection helpers (`e2e/ws-inject.ts`), with a `PerformanceObserver({type:"longtask"})` plus `performance.measure` around `applyRender`/`setData`. Use a Chrome trace for MapLibre. Precedent: `e2e/ships-demand.spec.ts:117` already asserts "radar timeline … within 200 ms".
4. **Bundle:** `npm run build && npm run check:first-js -- --in-image` (the reference) after every commit. `npm run measure:first-js -- --serve 8790` (CI) checks that the browser loads exactly the build list.

---

## 5. How the frontend is tested and built today, and the gaps

**Scripts (`package.json`):**

- `dev` and `build` each run a pre-step that copies the MapLibre worker to `public/maplibre/<version>`.
- `lint` runs `eslint .` with `next/core-web-vitals` + `next/typescript` and the react-hooks v7 compiler rules as errors.
- `typecheck` runs `tsc --noEmit`, which includes `tests/`; `e2e/` is excluded.
- `test` runs `vitest run`.
- `e2e` runs `playwright test`.
- `measure:first-js` uses Playwright in a real browser.
- `check:first-js` computes the gzip size of the build output against the 550,000 B budget; `--in-image` uses the web image's pinned Node and zlib.

**CI (`.github/workflows/ci.yml:84-104`, web job):** `npm ci` → `eslint . && tsc --noEmit && vitest run && npm run build` → `check:first-js -- --in-image` → `measure:first-js -- --serve 8790` → `npm audit --audit-level=high`. E2E is a separate job against the fixture stack.

**Vitest (`vitest.config.ts`):**

- `environment: "node"`, `include: tests/**/*.test.ts`, `@` alias.
- A v8 coverage config exists, but `@vitest/coverage-v8` is only present in `node_modules`; it is not a declared devDependency and not run in CI.
- **96 files, 1,413 tests, 11.1 s** locally.
- Styles in use:
  - mini-DOM mounts with real `react-dom/client` and `React.act`: 24 files.
  - SSR `renderToStaticMarkup`, often with `html-tree`: 45 files.
  - Pure `lib` tests.
  - Static-source contract tests: `first-screen-lazy`, `static-source`, `docs-contract-g11`, `worker-sync`.
  - `vi.mock` of maplibre, api, ws, `next/link` and `next/navigation`.

**E2E:**

- 12 specs on Playwright 1.63 against the isolated fixture stack (`:8701`, `make e2e`) with `workers: 1`.
- An `edge-limits` project runs after the app project.
- WS and REST injection helpers are validated by `tests/e2e-inject.test.ts`.
- Coverage includes layout at several sizes, the keyboard search flow, ops screens, replay 503 retry, stats states, the status-bar resize "no ResizeObserver loop" check, and "no CSP violations or uncaught errors across pages".

**Gaps:**

1. **No double-activation or in-flight tests.** B1, B2 and B3 all slipped through. Add a "click twice before the response" case to every write or paging button.
2. **No StrictMode mounts.** Dev-only double effects (B8) are invisible. Add a `strict` option to the mount helper and run the MapView lifecycle suite both ways.
3. **Poller lifecycle after `stop()` is untested** (B6). The same goes for the stacking and order of raw polls (B9).
4. **Untested fetch paths:**
   - SigmetCard "inside" list states (`/api/v1/sigmets/{id}` appears in no test);
   - `AirportList` loading and error states (only `AirportListView` SSR is tested);
   - the AircraftCard 30 s refresh;
   - `AisGapsTable` period switching;
   - LogsDashboard `openById` ordering.

   Add characterization tests before migrating these to `useApiResource`.
5. **REST response validation is uneven** (B10). Add parse-on-mismatch tests per endpoint function.
6. **No render-count or perf regression tests** and no benches (§4).
7. **mini-DOM limits:** no event bubbling or focus events, and attribute-only selectors, so keyboard and focus flows rely on e2e. Every mount test re-declares `find`, `propsOf`, `settle` and `click` (about 24 copies). One shared `tests/helpers/mount.ts` is worth it; this is test infrastructure, not app code. jsdom and Testing Library are **not** needed.
8. **No automated a11y assertions.** Use Playwright's built-in `toMatchAriaSnapshot` on the dashboard, ops and logs screens. The live-region rule (B7) can be pinned in a unit test (A.10).

---

## Appendix A — repro tests (fail today; adapt the paths when moving them into `tests/`)

Run them from the scratchpad without touching the repo:

```
cd apps/web && npx --no-install vitest run --config <scratchpad>/repro/vitest.repro.config.mjs --exclude "**/hotpath-timing*" --exclude "**/profiler-probe*"
```

Result today: **10 files, 11 tests, 11 failed** (every repro fails on the current code). The scratch config sets `root: apps/web`, the alias `@ → apps/web`, aliases `react` and `react-dom` to `apps/web/node_modules`, `globals: true`, and `test.dir` pointing at the scratchpad.

When moving a test into the repo:

- add `import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";`;
- import helpers from `./helpers/mini-dom` instead of `@/tests/helpers/mini-dom`.

**Shared harness** (as in `tests/logs-page-v5.test.ts`):

```ts
const dom = installMiniDom();
let React: typeof import("react"); let createRoot: typeof import("react-dom/client").createRoot;
beforeAll(async () => { React = await import("react"); ({ createRoot } = await import("react-dom/client")); });
afterAll(() => dom.restore());
let root: import("react-dom/client").Root | null = null;
afterEach(async () => { if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); } vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const find = (p: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => { if (p(from)) return from; for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(p, c) : null; if (f) return f; } return null; };
const byTestId = (id: string) => find((e) => e.getAttribute?.("data-testid") === id);
const propsOf = (e: MiniElement) => (e as any)[Object.keys(e).find((x) => x.startsWith("__reactProps$"))!];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
```

**A.1 — B6 `EtagPoller` after `stop()`** (pure; `tests/etag-poller.test.ts`)

```ts
import { EtagPoller, type PollState } from "@/lib/etag-poller";
it("does not publish a response that arrives after stop()", async () => {
  let resolveFetch!: (r: Response) => void;
  const published: PollState<unknown>[] = [];
  const p = new EtagPoller<unknown>({ url: "/api/v1/traffic/grid", parse: (x) => x as object, intervalMs: 60_000, visibleMinGapMs: 0 },
    (s) => published.push(s), undefined, () => new Promise<Response>((r) => { resolveFetch = r; }), () => false, () => 1000, () => () => {});
  p.start(); p.stop();
  resolveFetch(new Response(JSON.stringify({ cells: [] }), { status: 200, headers: { ETag: '"v1"' } }));
  await new Promise((r) => setTimeout(r, 20));
  expect(published).toEqual([]);                       // today: 1 state published
});
it("a stopped poller's late answer does not overwrite its replacement's state", async () => {
  const resolvers: ((r: Response) => void)[] = []; const fetcher = () => new Promise<Response>((r) => { resolvers.push(r); });
  let store: PollState<unknown> | null = null;
  const spec = { url: "/api/v1/traffic/grid", parse: (x: unknown) => x as object, intervalMs: 60_000, visibleMinGapMs: 0 };
  const a = new EtagPoller<unknown>(spec, (s) => { store = s; }, undefined, fetcher, () => false, () => 1000, () => () => {}); a.start(); a.stop();
  const b = new EtagPoller<unknown>(spec, (s) => { store = s; }, undefined, fetcher, () => false, () => 2000, () => () => {}); b.start();
  resolvers[1](new Response("{}", { status: 200, headers: { ETag: '"v2"' } })); await new Promise((r) => setTimeout(r, 20));
  resolvers[0](new Response("{}", { status: 200, headers: { ETag: '"v1"' } })); await new Promise((r) => setTimeout(r, 20)); b.stop();
  expect(store!.etag).toBe('"v2"');                    // today: '"v1"'
});
```

**A.2 — B1 logs load-more** (append to `tests/logs-page-v5.test.ts`)

```ts
it("double click on '이전 항목 더 보기' appends one page, not two", async () => {
  const NOW = Date.parse("2026-09-29T02:00:00Z"); const T = (m: number) => `${NOW - m * 60_000}-0`;
  const entry = (id: string) => ({ id, v: 1, ts: new Date(Number(id.split("-")[0])).toISOString(), service: "api", instance: "api-1", level: "ERROR", logger: "x.Y", thread: "t", message: `failure ${id}`, exception: null, fp: "0123456789abcdef", request_id: null, context: {}, suppressed: 0 });
  const FIRST = { items: [entry(T(1)), entry(T(2))], next_cursor: T(2), scanned: 10, scan_truncated: false, invalid: 1, hidden_resolved: 2 };
  const OLDER = { items: [entry(T(10))], next_cursor: null, scanned: 5, scan_truncated: false, invalid: 4, hidden_resolved: 3 };
  const older: ((r: Response) => void)[] = [];
  vi.stubGlobal("fetch", async (url: string) => url === "/api/v1/ops/session" ? json(200, { username: "op" })
    : url.startsWith("/api/v1/ops/logs?") && url.includes("cursor=") ? new Promise<Response>((r) => older.push(r))
    : url.startsWith("/api/v1/ops/logs?") ? json(200, FIRST) : json(404, {}));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
  vi.stubGlobal("self", globalThis); vi.stubGlobal("location", { hash: "", pathname: "/logs", origin: "http://localhost:8700" });
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement((await import("@/app/logs/page")).default)); }); await settle(); await settle();
  const more = find((e) => e.tagName === "BUTTON" && e.textContent.trim() === "이전 항목 더 보기")!;
  await React.act(async () => { void propsOf(more).onClick(); void propsOf(more).onClick(); });
  for (const r of older) r(json(200, OLDER)); await settle();
  expect(byTestId("logs-hidden-resolved")!.textContent).toBe("해결 처리로 숨김 5건(불러온 2쪽 합계)");   // today: "8건(불러온 3쪽 합계)"
  expect(byTestId("logs-skipped")!.textContent).toBe("형식 오류로 건너뜀(불러온 2쪽 합계): api 5 · 화면 0");
});
```

**A.3 — B2 settings double save** (`tests/ops-page.test.ts`). `BODY` is the file's fixture with `"/api/v1/ops/settings": { items: [{ key: "region_poll_s", value: 10, version: 3, updated_by: "op", updated_at: "2026-09-28T15:00:00Z" }] }`.

```ts
it("double click on save sends one PUT and keeps the success message", async () => {
  const puts: ((r: Response) => void)[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => init?.method === "PUT" ? new Promise<Response>((r) => puts.push(r)) : url in BODY ? json(200, BODY[url]) : json(404, {}));
  (dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t";
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-09-28T23:41:14Z") });
  root = createRoot(dom.container as never); await React.act(async () => { root!.render(React.createElement(OpsPage)); }); await settle(); await settle();
  await React.act(async () => { propsOf(byTestId("ops-tab-settings")!).onClick(); }); await settle();
  await React.act(async () => { propsOf(find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "region_poll_s 값")!).onChange({ target: { value: "15" } }); });
  const save = find((e) => e.tagName === "BUTTON" && e.textContent === "save")!;
  await React.act(async () => { void propsOf(save).onClick(); void propsOf(save).onClick(); });
  expect(puts).toHaveLength(1);                                                           // today: 2
  puts[0](json(200, {})); puts[1]?.(new Response(JSON.stringify({ detail: "version mismatch" }), { status: 409, headers: { "Content-Type": "application/problem+json" } }));
  await settle();
  expect(byTestId("settings-error")).toBeNull();                                          // today: "region_poll_s: 편집하는 동안 다른 곳에서 바뀌었습니다 …"
});
```

**A.4 — B4 write error cleared by the periodic reload** (`tests/ops-page.test.ts`). Providers fixture: `[{ name: "adsb_fi", disabled: "0" }]`. Also stub `self` (the `next/link` inside `ErrorNote` needs it).

```ts
vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => init?.method === "POST" ? json(500, { detail: "switch store unavailable", request_id: "feedface0000beef" }) : url in BODY ? json(200, BODY[url]) : json(404, {}));
// mount OpsPage (fake setInterval/Date), then:
await React.act(async () => { await propsOf(find((e) => e.tagName === "BUTTON" && e.textContent === "disable")!).onClick(); }); await settle();
expect(alertText()).toContain("switch store unavailable");
await React.act(async () => { vi.advanceTimersByTime(15_000); }); await settle();
expect(alertText()).toContain("switch store unavailable");                                // today: ''
```

**A.5 — B3 search choice race** (new `tests/search-choice.test.ts`). It needs the same globals as `search-ships-mount.test.ts:22-27` (`document.oninput = null`, `globalThis.addEventListener` stubs).

```ts
vi.stubGlobal("fetch", async (url: string) => url.startsWith("/api/v1/aircraft/search")
  ? json(200, { items: [{ hex: "aaaaaa", callsign: "AAA1", last_seen: "2026-09-29T00:00:00Z" }, { hex: "bbbbbb", callsign: "BBB2", lat: 37.5, lon: 127.0 }] })
  : url === "/api/v1/aircraft/aaaaaa" ? new Promise<Response>((r) => { detailA = r; })
  : url.startsWith("/api/v1/ships/search") ? json(200, { items: [] }) : json(404, {}));
// mount AircraftSearch; input onChange("AA"); await settle(300)
await React.act(async () => { void propsOf(items[0]).onClick(); });            // A: waits for REST detail, list closes
await React.act(async () => { propsOf(input).onFocus(); });                     // reopen
await React.act(async () => { void propsOf(itemsAgain[1]).onClick(); });       // B: live → flies now
detailA(json(200, { hex: "aaaaaa", state: { hex: "aaaaaa", lat: 10, lon: 20 } })); await settle();
expect(useUi.getState().selectedHex).toBe("bbbbbb");
expect(useUi.getState().flyTo).toMatchObject({ lon: 127.0, lat: 37.5 });         // today: { lon: 20, lat: 10, id: 2 }
```

**A.6 — B5 AirportCard stale error** (new `tests/airport-card.test.ts`; stub `self`)

```ts
vi.stubGlobal("fetch", async (url: string) => url === "/api/v1/airports/RKSI/wx"
  ? new Response(JSON.stringify({ detail: "wx store unavailable", request_id: "feedface0000beef" }), { status: 503, headers: { "Content-Type": "application/problem+json" } })
  : new Promise<Response>(() => {}));
await React.act(async () => { root!.render(React.createElement(AirportCard, { icao: "RKSI" })); }); await settle();
await React.act(async () => { root!.render(React.createElement(AirportCard, { icao: "RKSS" })); }); await settle();
expect(dom.container.textContent).not.toContain("wx store unavailable");        // today: RKSI's 503 + request id under "Airport · RKSS"
```

**A.7 — B8 StrictMode** (`tests/mapview-lifecycle.test.ts`, which already mocks maplibre, api and ws)

```ts
setData({ sigmets: fc as never, alerts: new Map() });                            // already in the store, as when returning to "/"
await React.act(async () => { root!.render(React.createElement(React.StrictMode, null, React.createElement(MapView))); });
expect(FakeMap.instances).toHaveLength(2);
const map = FakeMap.instances[1]; await React.act(async () => { map.fire("style.load"); map.fire("load"); });
expect((map.getSource("sigmets")!.data as { features: unknown[] }).features).toHaveLength(1);   // today: 0
```

**A.8 — B9 KR poll stacking** (`tests/mapview-lifecycle.test.ts`, whose `apiGet` mock never resolves)

```ts
vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); await mount();
await React.act(async () => { vi.advanceTimersByTime(5 * 60_000); });
expect(rec.api.filter((p) => p === "/api/v1/radar/kr")).toHaveLength(1);        // today: 6
```

**A.9 — B10 unvalidated KR body** (SSR; `tests/kma-missing.test.ts` style; stub `self`)

```ts
setData({ radarKr: { available: true, latest_tm: "202609281200" } as never });   // what pollKr stores for such a 200 body
expect(() => renderToStaticMarkup(createElement(RadarTimeline))).not.toThrow();  // today: TypeError reading 'length'
// after the fix the body is rejected in parseKrRadar (store keeps the last value + error), so the test belongs at the endpoint level too
```

**A.10 — B7 live region** (`tests/map-chips-a11y.test.ts`)

```ts
setData({ conn: "open", viewport: { bbox: [126, 34, 129, 37], zoom: 8 }, ships: { ...SHIPS_OFF, mode: "points", version: 1, count: 120, total: 120 } });
// mount MapChipsView { hex: null, shipsOn: true }
const live = () => find((e) => e.getAttribute?.("aria-live") === "polite")?.textContent ?? "";
const before = live();
await React.act(async () => { setData({ ships: { ...SHIPS_OFF, mode: "points", version: 2, count: 121, total: 121 } }); });
expect(live()).toBe(before);                                                      // today: "선박 120척 …" → "선박 121척 …" (announced)
```

## Appendix B — measurement probes (`scratchpad/repro/{hotpath-timing,profiler-probe}.repro.test.ts`)

```ts
// Pure-function timing (or turn into tests/perf/ships.bench.ts with `bench(...)` for `vitest bench`)
import { shipFeatures, sortShipRows } from "@/lib/ships";
import { shipList, shipRowFromLite, SHIP_SORT_DEFAULT } from "@/lib/ship-card";
// build N synthetic ShipLite (names, types, seen_at spread over 20 min), warm up twice, average 5–20 runs:
//   shipFeatures(map.values(), null, NOW)
//   sortShipRows(shipList(map.values(), "", Infinity, null).items.map(shipRowFromLite), SHIP_SORT_DEFAULT | {key:"age",dir:"desc"}, NOW).slice(0, 50)

// React work per trigger
root.render(<Profiler id="x" onRender={(_, __, actual) => commits.push(actual)}><AlertPanel/></Profiler>);
// clock: vi.useFakeTimers({ toFake: ["setInterval","clearInterval","Date"] }); 10× act(() => vi.advanceTimersByTime(1000))
// WS-like: 50× act(() => setData({ snapshotVersion, snapshotAt, aircraftCount }))   — same fields lib/ws.ts:515-519 writes per diff
// report commits.length (assert in CI) and sum(actualDuration) (print only)
```

Measured output: see §4. AlertPanel: 10 commits per 10 s at every N, with 9.2 / 31.3 / 25.0 ms total for N = 50 / 300 / 700 alerts. StatusBar: 50 commits and 5.9 ms for 50 diffs; 10 commits and 0.8 ms for 10 s of clock. ShipList and shipFeatures timings are in the P2 and P3 rows.
