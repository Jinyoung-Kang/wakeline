"use client";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { addBaseLayers, MAPLIBRE_WORKER_URL, STYLE_URL } from "@/lib/maplayers";

export interface ReplayFrame {
  at: string;
  aircraft: { hex: string; lat: number; lon: number; alt_ft: number | null; track_deg: number | null; gs_kt: number | null; provider: string }[];
  sigmets: { id: string; hazard: string; qualifier?: string | null; base_ft: number; top_ft?: number | null; fir_id: string; valid_from: string; valid_to: string; raw_text: string; geometry: GeoJSON.MultiPolygon | null }[];
  source: string;
}

/** 재생 지도: 보간 없음(기록된 위치 그대로), 레이더는 프레임 시각과 맞는 것이 있을 때만. */
export function ReplayMap({ frame, onBbox }: { frame: ReplayFrame | null; onBbox: (bbox: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  useEffect(() => {
    if (!el.current) return;
    maplibregl.setWorkerUrl(MAPLIBRE_WORKER_URL);
    const map = new maplibregl.Map({ container: el.current, style: STYLE_URL, center: [127.8, 36.5], zoom: 6, minZoom: 2, maxZoom: 12, attributionControl: false });
    map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: "Replay from local PostGIS history · adsb.lol/adsb.fi · AviationWeather.gov" }), "bottom-right");
    mapRef.current = map;
    const emit = () => { const b = map.getBounds(); onBbox(`${b.getWest().toFixed(3)},${b.getSouth().toFixed(3)},${b.getEast().toFixed(3)},${b.getNorth().toFixed(3)}`); };
    map.on("load", () => { addBaseLayers(map); emit(); });
    map.on("moveend", emit);
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !frame) return;
    const apply = () => {
      (map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: frame.aircraft.map((a) => ({ type: "Feature", id: a.hex, properties: { hex: a.hex, alt_ft: a.alt_ft, track_deg: a.track_deg, estimated: false, stale: false, callsign: a.hex }, geometry: { type: "Point", coordinates: [a.lon, a.lat] } })),
      });
      (map.getSource("sigmets") as maplibregl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: frame.sigmets.filter((s) => s.geometry).map((s) => ({ type: "Feature", id: s.id, properties: { ...s, geometry: undefined }, geometry: s.geometry! })),
      });
    };
    if (map.isStyleLoaded()) apply(); else map.once("load", apply);
  }, [frame]);
  return <div ref={el} className="h-full w-full" />;
}
