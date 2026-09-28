/**
 * 시험 전용: 스키마(schemas/ws/server.v1.json)의 잎 제약을 표본 위에서 모두 훑어 "틀린 값" · "경계의 맞는 값" 변형을 만든다(2차 리뷰 — 웹 검증기가
 * 스키마와 어긋나지 않는지 손으로 고른 몇 가지가 아니라 제약마다 확인한다).
 * - 표본 값과 스키마를 함께 따라 내려간다($ref · allOf · 값에 맞는 anyOf/oneOf 가지 · properties · additionalProperties · prefixItems · items).
 *   배열은 첫 원소만(같은 스키마의 원소를 모두 훑지 않는다).
 * - 제약 하나마다 틀린 값 하나(violations) · 스키마가 허용하는 끝값(boundaries)을 만든다. 없는 키 · null 은 만들지 않는다(웹은 "모름"으로 받는다 — ADR-020).
 * - 만든 변형이 정말 위반인지는 호출부가 mini-schema 로 확인한다.
 */
import { validate } from "./mini-schema";

type Json = Record<string, unknown>;
export type Path = (string | number)[];
export interface Mutation { path: Path; rule: string; value: unknown }

const clone = <T>(v: T): T => structuredClone(v);
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function getAt(o: unknown, path: Path): unknown {
  let cur = o;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

export function setAt(o: unknown, path: Path, value: unknown): void {
  let cur = o as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
  cur[path[path.length - 1]] = value;
}

function resolve(root: Json, s: Json): Json {
  if (typeof s.$ref === "string") {
    const def = (root.$defs as Record<string, Json>)[s.$ref.slice("#/$defs/".length)];
    const rest: Json = { ...s };
    delete rest.$ref;
    return { ...resolve(root, def), ...rest };
  }
  return s;
}

interface Site { path: Path; schema: Json; value: unknown }

/** 값과 함께 스키마를 따라 내려가며 제약이 걸린 자리를 모은다 */
function walk(root: Json, schema: Json, value: unknown, path: Path, out: Site[]): void {
  const s = resolve(root, schema);
  if (Array.isArray(s.allOf)) for (const sub of s.allOf as Json[]) walk(root, sub, value, path, out);
  for (const k of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(s[k])) continue;
    const branch = (s[k] as Json[]).find((b) => validate(root, value, b).length === 0);
    if (branch) walk(root, branch, value, path, out);
  }
  out.push({ path, schema: s, value });
  if (isObj(value)) {
    const props = (s.properties ?? {}) as Record<string, Json>;
    for (const [k, v] of Object.entries(value)) {
      if (k in props) walk(root, props[k], v, [...path, k], out);
      else if (isObj(s.additionalProperties)) walk(root, s.additionalProperties, v, [...path, k], out);
    }
  }
  if (Array.isArray(value) && value.length > 0) {
    const prefix = (s.prefixItems ?? []) as Json[];
    prefix.forEach((p, i) => { if (i < value.length) walk(root, p, value[i], [...path, i], out); });
    if (isObj(s.items) && value.length > prefix.length) walk(root, s.items, value[prefix.length], [...path, prefix.length], out);
  }
}

const types = (s: Json): string[] => (s.type === undefined ? [] : Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]);

/** 이 자리의 제약을 하나씩 어기는 값 */
function violations(site: Site): Mutation[] {
  const { schema: s, value: v, path } = site;
  const out: Mutation[] = [];
  const add = (rule: string, value: unknown) => out.push({ path, rule, value });
  const t = types(s);
  if ("const" in s) add("const", typeof s.const === "number" ? s.const + 1 : typeof s.const === "boolean" ? !s.const : `${String(s.const)}_x`);
  if (Array.isArray(s.enum)) {
    const nums = (s.enum as unknown[]).every((e) => typeof e === "number");
    add("enum", nums ? [3, 7, 42, 1.5].find((n) => !(s.enum as unknown[]).includes(n)) : "made_up");
  }
  if (t.length === 1) {
    const wrong: Record<string, unknown> = { string: 42, integer: "1", number: "1", boolean: "true", object: "x", array: "x" };
    if (t[0] in wrong) add(`type ${t[0]}`, wrong[t[0]]);
    if (t[0] === "integer") add("integer", (typeof v === "number" ? v : 1) + 0.5);
  }
  const int = t.includes("integer");
  if (typeof s.minimum === "number") add("minimum", s.minimum - (int ? 1 : 0.5));
  if (typeof s.maximum === "number") add("maximum", s.maximum + (int ? 1 : 0.5));
  if (typeof s.exclusiveMinimum === "number") add("exclusiveMinimum", s.exclusiveMinimum);
  if (typeof s.exclusiveMaximum === "number") add("exclusiveMaximum", s.exclusiveMaximum);
  if (typeof s.minLength === "number" && s.minLength > 0) add("minLength", "A".repeat(s.minLength - 1));
  if (typeof s.maxLength === "number") add("maxLength", "A".repeat(s.maxLength + 1));
  if (typeof s.pattern === "string") add("pattern", "#!");
  if (s.format === "date-time") {
    add("date-time", "9999");
    add("date-time", "2026-09-29 03:00:00Z");
    add("date-time", "2026-02-30T00:00:00Z");
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && s.minItems > 0 && v.length >= s.minItems) add("minItems", clone(v).slice(0, s.minItems - 1));
    if (typeof s.maxItems === "number" && v.length > 0) add("maxItems", [...clone(v), ...Array.from({ length: s.maxItems + 1 }, () => clone(v[0]))].slice(0, s.maxItems + 1));
  }
  if (typeof s.minProperties === "number" && s.minProperties > 0 && isObj(v)) add("minProperties", {});
  return out;
}

/** 이 자리에서 스키마가 허용하는 끝값(웹이 스키마보다 엄격하지 않은지) */
function boundaries(site: Site): Mutation[] {
  const { schema: s, path } = site;
  const out: Mutation[] = [];
  const add = (rule: string, value: unknown) => out.push({ path, rule, value });
  const t = types(s);
  if ("const" in s) return out;
  if (Array.isArray(s.enum)) {
    for (const e of s.enum as unknown[]) add(`enum ${JSON.stringify(e)}`, e);
    return out;
  }
  const numeric = t.includes("integer") || t.includes("number");
  if (numeric) {
    const int = t.includes("integer");
    if (typeof s.minimum === "number") add("minimum", s.minimum);
    if (typeof s.maximum === "number") add("maximum", s.maximum);
    if (typeof s.exclusiveMinimum === "number") add("exclusiveMinimum+", s.exclusiveMinimum + (int ? 1 : 0.5));
    if (typeof s.exclusiveMaximum === "number") add("exclusiveMaximum-", s.exclusiveMaximum - (int ? 1 : 0.5));
    if (s.maximum === undefined && s.exclusiveMaximum === undefined) add("no maximum", 1e9);
    if (s.minimum === undefined && s.exclusiveMinimum === undefined) add("no minimum", -1e9);
  }
  if (t.includes("string") && s.pattern === undefined && s.format === undefined) {
    if (typeof s.maxLength === "number") add("maxLength", "A".repeat(s.maxLength));
    else add("no maxLength", "A".repeat(300));
    if (typeof s.minLength === "number" && s.minLength > 0) add("minLength", "A".repeat(s.minLength));
  }
  if (s.format === "date-time") {
    add("date-time offset", "2026-09-29T12:00:00.123456+09:00");
    add("date-time Z", "2026-09-29T03:00:00Z");
  }
  if (t.includes("boolean")) { add("true", true); add("false", false); }
  return out;
}

export interface Sweep { violations: Mutation[]; boundaries: Mutation[] }

/** 표본 하나(메시지)의 모든 제약 자리 → 변형 목록. 메시지 type 은 건드리지 않는다(다른 종류가 된다). */
export function sweep(root: Json, message: Json): Sweep {
  const sites: Site[] = [];
  walk(root, root, message, [], sites);
  const keep = (m: Mutation) => !(m.path.length === 1 && m.path[0] === "type") && m.path.length > 0;
  return { violations: sites.flatMap(violations).filter(keep), boundaries: sites.flatMap(boundaries).filter(keep) };
}

/** 변형을 적용한 사본 */
export function mutated(message: Json, m: Mutation): Json {
  const c = clone(message);
  setAt(c, m.path, clone(m.value));
  return c;
}
