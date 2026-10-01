// scripts/guide-capture-lib.mjs 의 형식(시험이 TypeScript 에서 부른다)
export interface CaptureArgs { baseUrl: string; credFile: string; only: string[] | null; skip: string[] | null; outDir: string | null; quality: number; allowFixture: boolean }
export interface Rect { left: number; top: number; width: number; height: number }
export type Anchor = "tl" | "tr" | "bl" | "br" | "c" | "l" | "r" | "t" | "b";
export interface ManifestEntry { file: string; format: string; width: number; height: number; bytes: number; captured_at: string; variant: string | null; callouts: { n: number; x: number; y: number }[] }
export interface Manifest { version: 1; shots: Record<string, ManifestEntry> }
export interface ReportRow { id: string; format: string; bytes: number; pngBytes: number; callouts: [number, number]; variant: string | null }

export class Skip extends Error {}
export class Fatal extends Error {}
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const REAL_CLOCK: Clock;

export const FILE_RE: RegExp;
export const DEFAULT_QUALITY: number;
export const ERROR_MARKS: readonly string[];
export const USAGE: string;
export function parseArgs(argv: string[]): CaptureArgs;
export function selectShots(planIds: readonly string[], sel: { only: readonly string[] | null; skip: readonly string[] | null }): string[];
export function checkLocalBase(s: string): string;
export function realDataVerdict(httpStatus: number, body: unknown): string | null;
export function stackNote(httpStatus: number, body: unknown): string | null;
export function withStackNote(note: string | null, variant: string | null): string | null;
export interface StackState { note: string | null; checked: boolean }
export const STACK_UNCHECKED: StackState;
export function stackTransition(prev: string | null, next: string | null, checked: boolean): string | null;
export function checkStack(o: { fetchStatus: () => Promise<{ code: number; body: unknown }>; allowFixture: boolean; state: StackState; when: string }): Promise<StackState>;
export function fixtureVariant(variant: string | null | undefined): boolean;
export function isHotActive(kind: string | null | undefined, text: string | null | undefined): boolean;
export function chipCount(text: string | null | undefined): number | null;
export function worldVariant(path: string, aircraft: number): string;
export function hotVariant(path: string, chipText: string, aircraft: number): string;
/** mapProbeInPage 가 읽은 값(없으면 null) */
export interface MapProbe { health: string | null; chip: { kind: string | null; text: string } | null; count: string | null }
export const MAP_PROBE: { health: { testId: string; attr: string }; chip: { testId: string; attr: string }; count: { testId: string; value: string } };
export function mapProbeInPage(p: typeof MAP_PROBE): MapProbe;
export type Reading = { skip: string; variant?: undefined } | { variant: string; skip?: undefined };
export function worldReading(probe: MapProbe | null, path: string): Reading;
export function hotReading(probe: MapProbe | null, path: string): Reading;
export function until<T>(fn: () => Promise<T>, ms: number, clock?: Clock, stepMs?: number): Promise<T>;
export const HOT_WAIT_MS: number;
export const WORLD_WAIT_MS: number;
export interface ReadingSpec { decide: (probe: MapProbe | null, path: string) => Reading; limitMs: number; settleMs: number }
export const READINGS: { world: ReadingSpec; hot: ReadingSpec };
export function awaitReading(spec: ReadingSpec, o: { probe: () => Promise<unknown>; path: string; clock?: Clock }): Promise<() => Promise<string>>;
export const READ_TRIES: number;
export function stableRead(before: string | null, after: string | null, attempt: number, tries?: number): boolean;
export function shootStable<S>(read: (() => Promise<string>) | null, shoot: () => Promise<S>, tries?: number): Promise<{ shot: S; reading: string | null }>;
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
