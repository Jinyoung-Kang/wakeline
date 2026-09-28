/**
 * 시험 전용 최소 JSON Schema(2020-12) 검사기 — schemas/ws/*.json 이 쓰는 키워드만. 웹 번들에는 싣지 않는다(ADR-020).
 * 모르는 키워드를 만나면 예외를 던진다 — 스키마에 새 키워드가 들어왔는데 조용히 통과시키지 않게.
 * 웹 시험이 (1) 웹이 실제로 보낸 클라이언트 메시지가 client.v1.json 을 만족하는지, (2) 시험이 만든 "틀린 표본" 이 정말 스키마 위반인지 확인하는 데 쓴다.
 * 스키마 판정의 원천은 api(networknt)·contract_check(Python jsonschema) 이고, 이 검사기는 그 둘과 같은 표본으로 교차 확인된다.
 */
type Schema = Record<string, unknown> | boolean;

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$comment", "$defs"]);
const KNOWN = new Set([
  "type", "required", "properties", "additionalProperties", "oneOf", "anyOf", "allOf", "$ref", "const", "enum",
  "minItems", "maxItems", "prefixItems", "items", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "pattern", "minLength", "maxLength", "minProperties", "format",
]);
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
/** RFC 3339 date-time + 달력에 있는 날짜 · 시각(Python datetime.fromisoformat 과 같게 — 2월 30일 · 24시 · 60초는 틀림). Date.parse 는 2월 30일을 받는다 */
function isDateTime(v: string): boolean {
  const m = RFC3339.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days && h <= 23 && mi <= 59 && se <= 59 && (m[9] === undefined || (Number(m[9]) <= 23 && Number(m[10]) <= 59));
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(t: string, v: unknown): boolean {
  const actual = typeOf(v);
  return t === actual || (t === "number" && actual === "integer");
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 위반 목록(맞으면 빈 목록). root 는 $ref(#/$defs/…) 를 풀 문서. */
export function validate(root: Record<string, unknown>, value: unknown, schema: Schema = root, path = ""): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path || "/"}: not allowed`];
  const errs: string[] = [];
  for (const k of Object.keys(schema)) if (!ANNOTATIONS.has(k) && !KNOWN.has(k)) throw new Error(`mini-schema: unsupported keyword ${k}`);
  const s = schema as Record<string, unknown>;
  const at = path || "/";
  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    if (!ref.startsWith("#/$defs/")) throw new Error(`mini-schema: unsupported $ref ${ref}`);
    const def = (root.$defs as Record<string, Schema>)[ref.slice("#/$defs/".length)];
    if (def === undefined) throw new Error(`mini-schema: missing ${ref}`);
    errs.push(...validate(root, value, def, path));
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeMatches(t, value))) return [...errs, `${at}: type ${typeOf(value)} is not ${types.join("|")}`];
  }
  if ("const" in s && !deepEqual(value, s.const)) errs.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, value))) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (Array.isArray(s.allOf)) for (const sub of s.allOf as Schema[]) errs.push(...validate(root, value, sub, path));
  if (Array.isArray(s.anyOf) && !(s.anyOf as Schema[]).some((sub) => validate(root, value, sub, path).length === 0)) errs.push(`${at}: matches no anyOf branch`);
  if (Array.isArray(s.oneOf)) {
    const ok = (s.oneOf as Schema[]).filter((sub) => validate(root, value, sub, path).length === 0).length;
    if (ok !== 1) errs.push(`${at}: matches ${ok} oneOf branches (exactly 1 required)`);
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) errs.push(`${at}: < minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) errs.push(`${at}: > maximum ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) errs.push(`${at}: ≤ exclusiveMinimum ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) errs.push(`${at}: ≥ exclusiveMaximum ${s.exclusiveMaximum}`);
  }
  if (typeof value === "string") {
    const len = Array.from(value).length;
    if (typeof s.minLength === "number" && len < s.minLength) errs.push(`${at}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && len > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) errs.push(`${at}: does not match ${s.pattern}`);
    if (s.format === "date-time" && !isDateTime(value)) errs.push(`${at}: not an RFC 3339 date-time`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) errs.push(`${at}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`);
    const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
    value.forEach((v, i) => {
      const sub = i < prefix.length ? prefix[i] : (s.items as Schema | undefined);
      if (sub !== undefined) errs.push(...validate(root, v, sub, `${path}/${i}`));
    });
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof s.minProperties === "number" && Object.keys(o).length < s.minProperties) errs.push(`${at}: fewer than ${s.minProperties} properties`);
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in o)) errs.push(`${at}: missing ${r}`);
    const props = (s.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, v] of Object.entries(o)) {
      if (k in props) errs.push(...validate(root, v, props[k], `${path}/${k}`));
      else if (s.additionalProperties !== undefined) errs.push(...validate(root, v, s.additionalProperties as Schema, `${path}/${k}`));
    }
  }
  return errs;
}
