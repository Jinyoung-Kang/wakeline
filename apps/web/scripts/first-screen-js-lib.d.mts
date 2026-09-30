// scripts/first-screen-js-lib.mjs 의 형식(시험이 TypeScript 에서 부른다)
export type Group = "entry" | "dynamic" | "maplibre" | "public";
export interface FileRef { group: Group; file: string; abs: string }
export interface Row { group: string; file: string; raw: number; body: number }
export interface Summary { count: number; raw: number; body: number; groups: Record<string, { count: number; raw: number; body: number }> }
export interface MeasureArgs { baseUrl: string; serve: number | null; settleMs: number; json: string | null; budget: number | null }

export const GZIP_LEVEL: number;
export const GZIP_THRESHOLD: number;
export const KIB: number;
export const FIRST_SCREEN_JS_BUDGET: number;
export const FIRST_SCREEN_PUBLIC_SCRIPTS: readonly string[];
export function servedBytes(buf: Uint8Array): number;
export function fmtKiB(b: number): string;
export function firstScreenFiles(webDir: string): FileRef[];
export function measureFiles(files: FileRef[]): Row[];
export function summarize(rows: Row[]): Summary;
export function budgetVerdict(totalBody: number, budget: number): string | null;
export function formatReport(rows: Row[], title: string): string;
export function isScriptResponse(resourceType: string, contentType: string | null | undefined): boolean;
export function groupOfPath(pathname: string): "maplibre" | "next" | "public";
export const MEASURE_USAGE: string;
export function parseMeasureArgs(argv: string[]): MeasureArgs;
export function runCheck(webDir: string, budget?: number, opts?: { image?: string | null; reference?: string | null }): { code: 0 | 1 | 2; out: string; err: string };
export function compressorLabel(p?: { version: string; versions: { zlib?: string }; platform: string; arch: string }): string;
export function webImageNode(dockerfile: string): string;
export function inImageArgs(webDir: string, image: string): string[];
export const CHECK_USAGE: string;
export function parseCheckArgs(argv: string[]): { inImage: boolean; image: string | null };
export function dockerExitCode(status: number | null, signal: string | null): 0 | 1 | 2;
export const AFTER_FIRST_SCREEN_MARK: string;
export function classifyScripts(urls: string[], entries: { name: string; startTime: number }[], markStart: number | null): Record<string, "first" | "after">;
export function compareWithBuild(buildFiles: string[], browserFiles: string[]): { extra: string[]; missing: string[] };
export const MEASURE_VIEWPORTS: readonly { width: number; height: number; why: string }[];
