// scripts/guide-capture-lib.mjs 의 형식(시험이 TypeScript 에서 부른다)
export interface CaptureArgs { baseUrl: string; credFile: string; only: string[] | null; outDir: string | null; quality: number; allowFixture: boolean }
export interface Rect { left: number; top: number; width: number; height: number }
export type Anchor = "tl" | "tr" | "bl" | "br" | "c" | "l" | "r" | "t" | "b";
export interface ManifestEntry { file: string; format: string; width: number; height: number; bytes: number; captured_at: string; variant: string | null; callouts: { n: number; x: number; y: number }[] }
export interface Manifest { version: 1; shots: Record<string, ManifestEntry> }
export interface ReportRow { id: string; format: string; bytes: number; pngBytes: number; callouts: [number, number]; variant: string | null }

export const FILE_RE: RegExp;
export const DEFAULT_QUALITY: number;
export const ERROR_MARKS: readonly string[];
export const USAGE: string;
export function parseArgs(argv: string[]): CaptureArgs;
export function checkLocalBase(s: string): string;
export function realDataVerdict(httpStatus: number, body: unknown): string | null;
export const STATS_PANELS: number;
/** 통계 패널 하나(app/stats/page.tsx 의 data-stats-panel · data-state · 글자) */
export interface StatsPanel { id: string | null; state: string | null; text?: string | null }
export function statsPanelsVerdict(panels: readonly StatsPanel[]): { wait: boolean; skip: string | null };
export function findColumn(headers: readonly string[], name: string): number;
export const VARIANT_MAX: number;
export function maskedVariant(variant: string | null, labels: readonly string[]): string | null;
export function parseCredentials(text: string): { username: string; password: string };
export function credentialFileWarning(mode: number): string | null;
export function anchorPoint(rect: Rect | null, anchor: Anchor, vp: { width: number; height: number }): { x: number; y: number } | null;
export function hashedName(id: string, bytes: Uint8Array, ext: "webp" | "png"): string;
export function mergeManifest(prev: unknown, captured: Record<string, ManifestEntry>, planIds: string[]): Manifest;
export function staleFiles(files: string[], manifest: { shots: Record<string, { file: string }> }): string[];
export function sizeReport(rows: ReportRow[], skipped?: { id: string; reason: string }[]): string;
