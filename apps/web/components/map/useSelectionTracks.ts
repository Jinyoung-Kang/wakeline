"use client";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { getData, serverNowMs, setData, shipStates, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { onReady } from "@/lib/map-ready";
import { aircraftTrack, shipTrack as fetchShipTrack } from "@/lib/endpoints/tracks";
import { appendShipTrack, mergeStatusGaps, selectedShipPos, shipTrackFeatures, shipTrackPointFeatures, type ShipTrack } from "@/lib/ships";
import { appendTrackPoint, mergeTrack, pointFromState, trackError, trackFeatureCollection, type TrackPt } from "@/lib/track";
import type { WakelineWsClient } from "@/lib/ws";

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
/** REST 항적을 받기 전에 온 실시간 관측 보류 상한 */
const SHIP_PENDING_MAX = 500;

/** 지도마다의 실시간 피드(WS 클라이언트 · 보간 워커 · 예측선 갱신) — 지도가 바뀌면 새것이다. 없으면(지도 전 · 떠난 뒤) null */
export interface LiveFeed { client: WakelineWsClient; worker: Worker; refreshPrediction: () => void }
export type FeedRef = { readonly current: LiveFeed | null };

type LiveTrackPt = Parameters<typeof appendShipTrack>[1];
type ShipTrackRef = { mmsi: string | null; track: ShipTrack; pending: LiveTrackPt[]; loaded: boolean; anchor: number | null; sinceMs: number };
const emptyShipTrack = (mmsi: string | null, anchor: number | null = null, sinceMs = 0): ShipTrackRef => ({ mmsi, track: { segs: [], gaps: [] }, pending: [], loaded: false, anchor, sinceMs });

function geo(map: maplibregl.Map, id: string) {
  return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
}

/** 선택 선박의 가장 최근 위치(WS ship_selected → 지도 목록 사본 — lib/ships selectedShipPos). 모르면 null */
const shipPos = (mmsi: string | null) => selectedShipPos(mmsi, getData().shipSelected, shipStates);

/** 선택 선박 항적 요약(카드의 공백 목록·구간 수)을 스토어에 — 같은 선박일 때만, 불러오기 상태·오류는 그대로 */
function publishShipTrack(ref: ShipTrackRef) {
  const cur = getData().shipTrack;
  if (!cur || cur.mmsi !== ref.mmsi) return;
  setData({ shipTrack: { ...cur, gaps: ref.track.gaps.slice(), gapsTruncated: ref.track.gapsTruncated === true, segments: ref.track.segs.length } });
}

/** 선택 선박 항적(선 + 호버 점)을 지도에 */
function drawShipTrack(map: maplibregl.Map, track: ShipTrack) {
  geo(map, "ship-track")?.setData(shipTrackFeatures(track));
  geo(map, "ship-track-points")?.setData(shipTrackPointFeatures(track));
}

/**
 * 상황판 지도의 선택 항적(web-review §3.2 — MapView 에서 뗀 묶음): 고른 항공기 · 선박을 WS 로 알리고(select · select_ship · 켜진 레이어),
 * 그 항적을 REST 로 한 번 받아 그린 뒤 WS 선택 상태(selected · ship_selected)로 잇는다. 선박 항적은 AIS 공백 · 15분 틈을 점선으로(계약 v5 §B3).
 * 지도가 바뀌면(실시간 피드도 새것) 알림 · 항적을 그 지도에 다시 한다. 항적 기록(어느 항공기 · 선박의 무엇을 받았는지)은 이 Hook 이 갖는다.
 */
export function useSelectionTracks(map: maplibregl.Map | null, feed: FeedRef): void {
  const layers = useUi((s) => s.layers);
  const selectedHex = useUi((s) => s.selectedHex);
  const selectedShip = useUi((s) => s.selectedShip);
  const selectShip = useUi((s) => s.selectShip);
  const shipTrackHours = useUi((s) => s.shipTrackHours);
  const selectedInfo = useServerData((d) => d.selected);
  const shipSelected = useServerData((d) => d.shipSelected);
  const ais = useServerData((d) => d.ais);
  /** 선택 항공기 항적: REST 한 번 + WS selected 로 연장 */
  const track = useRef<{ hex: string | null; pts: TrackPt[]; pending: TrackPt[]; loaded: boolean }>({ hex: null, pts: [], pending: [], loaded: false });
  /** 선택 선박 항적: REST 한 번 + WS ship_selected 로 연장(AIS 공백·15분 틈은 점선) */
  const shipTrack = useRef<ShipTrackRef>(emptyShipTrack(null));

  // ---- 서버에 켜진 레이어 알림(선박은 켠 세션에만 온다). 선박을 끄면 선택도 해제 ----
  useEffect(() => {
    feed.current?.client.setLayers(layers.aircraft, layers.ships);
    if (!layers.ships && useUi.getState().selectedShip) selectShip(null);
  }, [map, feed, layers.aircraft, layers.ships, selectShip]);

  // ---- 선택 선박: WS select_ship(선택이 바뀔 때만 — 지도가 바뀌면 새 피드에) ----
  useEffect(() => { feed.current?.client.selectShip(selectedShip); }, [map, feed, selectedShip]);

  // ---- 선택 선박 항적: REST 한 번(기간 6·12·24 h — 바꾸면 다시), 이후 ship_selected 로 연장 ----
  useEffect(() => {
    // 이어 붙일 기준: 선택한 순간 알던 선박의 마지막 관측 시각(REST 구간 끝 시각을 서버가 주지 않을 때만 쓴다)
    const lite = selectedShip ? shipStates.get(selectedShip) : undefined;
    const anchor = lite?.seen_at ? Date.parse(lite.seen_at) : NaN;
    const to = serverNowMs(Date.now());
    const from = to - shipTrackHours * 3600_000; // 기간(계약 v5 §B3): 6 · 12 · 24 h
    shipTrack.current = emptyShipTrack(selectedShip, Number.isNaN(anchor) ? null : anchor, from);
    setData({ shipTrack: selectedShip ? { mmsi: selectedShip, loaded: false, error: null, gaps: [], gapsTruncated: false, segments: 0, fromMs: from, hours: shipTrackHours } : null });
    if (!map) return;
    onReady(map, "ship-track", () => drawShipTrack(map, { segs: [], gaps: [] }));
    if (!selectedShip) return;
    let cancelled = false;
    const finish = (track: ShipTrack, error: string | null, requestId: string | null = null) => {
      const ref = shipTrack.current;
      if (cancelled || ref.mmsi !== selectedShip) return;
      // REST 공백(scope 포함)과 상태 공백을 이 선박 위치로 가른다 — 다른 구역의 공백은 이 선박 카드·연결선에 넣지 않는다(계약 v4 §G)
      mergeStatusGaps(track, getData().ais, ref.sinceMs, shipPos(selectedShip));
      for (const p of ref.pending) appendShipTrack(track, p, ref.anchor);
      shipTrack.current = { ...ref, track, pending: [], loaded: true };
      setData({ shipTrack: { mmsi: selectedShip, loaded: true, error, requestId, gaps: track.gaps.slice(), gapsTruncated: track.gapsTruncated === true, segments: track.segs.length, fromMs: from, hours: shipTrackHours } });
      onReady(map, "ship-track", () => drawShipTrack(map, track));
    };
    fetchShipTrack(selectedShip, from, to)
      .then((t) => finish(t, null))
      // 기록이 없거나 DB 장애 → 실시간 관측만으로 잇는다. 요청 id 는 카드의 문구에(계약 v5 §G5)
      .catch((e: unknown) => { const t = trackError(e); finish({ segs: [], gaps: [] }, t.error, t.requestId); });
    return () => { cancelled = true; };
  }, [map, selectedShip, shipTrackHours]);

  useEffect(() => {
    const ref = shipTrack.current;
    const st = shipSelected?.state;
    if (!map || !shipSelected || shipSelected.mmsi !== ref.mmsi || !st?.seen_at) return;
    const ts = Date.parse(st.seen_at);
    if (Number.isNaN(ts)) return;
    // 호버 점에 받은 속력·침로·선수방위·항해 상태도(계약 v5 §B3)
    const p = { ts, lon: st.lon, lat: st.lat, sog_kn: st.sog_kn, cog_deg: st.cog_deg, heading_deg: st.heading_deg, nav_status: st.nav_status };
    if (!ref.loaded) { if (ref.pending.length < SHIP_PENDING_MAX) ref.pending.push(p); return; }
    const segs = ref.track.segs.length;
    const merged = mergeStatusGaps(ref.track, getData().ais, ref.sinceMs, { lat: st.lat, lon: st.lon });
    const appended = appendShipTrack(ref.track, p, ref.anchor);
    if (merged || appended) onReady(map, "ship-track", () => drawShipTrack(map, ref.track));
    if (merged || ref.track.segs.length !== segs) publishShipTrack(ref);
  }, [map, shipSelected]);

  // ---- AIS 상태가 바뀌면(공백 열림·닫힘) 선택 선박 항적의 공백 목록도 바로 고친다 — 닫힌 공백을 "진행 중"으로 남기지 않는다 ----
  useEffect(() => {
    const ref = shipTrack.current;
    if (!map || !ref.mmsi || !ref.loaded || !mergeStatusGaps(ref.track, ais, ref.sinceMs, shipPos(ref.mmsi))) return;
    onReady(map, "ship-track", () => drawShipTrack(map, ref.track));
    publishShipTrack(ref);
  }, [map, ais]);

  // ---- 선택 항공기: WS select + 항적(REST 한 번, 이후 selected 로 연장) ----
  useEffect(() => {
    feed.current?.client.select(selectedHex);
    feed.current?.worker.postMessage({ type: "invalidate" }); // 선택 강조를 바로 다시 그린다
    track.current = { hex: selectedHex, pts: [], pending: [], loaded: false };
    if (!map) return;
    onReady(map, "tracks", () => { geo(map, "tracks")?.setData(EMPTY_FC); feed.current?.refreshPrediction(); });
    if (!selectedHex) return;
    let cancelled = false;
    const finish = (rest: TrackPt[]) => {
      if (cancelled || track.current.hex !== selectedHex) return;
      const pts = mergeTrack(rest, track.current.pending);
      track.current = { hex: selectedHex, pts, pending: [], loaded: true };
      onReady(map, "tracks", () => geo(map, "tracks")?.setData(trackFeatureCollection(pts)));
    };
    aircraftTrack(selectedHex)
      .then((pts) => finish(pts))
      .catch(() => finish([])); // DB 기록이 없거나(전세계 항공기) DB 장애 → 실시간 관측만으로 잇는다
    return () => { cancelled = true; };
  }, [map, feed, selectedHex]);

  useEffect(() => {
    feed.current?.refreshPrediction();
    const t = track.current;
    if (!map || !selectedInfo || selectedInfo.hex !== t.hex) return;
    const p = pointFromState(selectedInfo.state);
    if (!p) return;
    if (!t.loaded) { appendTrackPoint(t.pending, p); return; }
    if (appendTrackPoint(t.pts, p)) onReady(map, "tracks", () => geo(map, "tracks")?.setData(trackFeatureCollection(t.pts)));
  }, [map, feed, selectedInfo]);
}
