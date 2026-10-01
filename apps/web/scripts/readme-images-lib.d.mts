// scripts/readme-images-lib.mjs 의 형식(시험이 TypeScript 에서 부른다)
export interface ReadmeImage { name: string; shot: string; fixture: boolean }
export interface ReadmeConfig { images: ReadmeImage[] }
export interface ReadmeRef { file: string; alt: string | null }
export interface CopiedImage { name: string; shot: string; from: string; to: string; bytes: number; captured_at: string; variant: string | null; fixture: boolean }
export interface ExportResult { problems: string[]; copied: CopiedImage[]; removed: { file: string; bytes: number }[] }

export const README_IMAGE_DIR: string;
export function parseReadmeConfig(raw: unknown, planIds: readonly string[]): ReadmeConfig;
export function readmeImageRefs(readme: string): ReadmeRef[];
export function staleImages(files: readonly string[], keep: readonly string[]): string[];
export function exportReadmeImages(o: { root: string; web: string; config: ReadmeConfig; manifest: unknown; readme: string; dryRun?: boolean }): ExportResult;
