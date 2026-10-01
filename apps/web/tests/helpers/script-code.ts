/**
 * 노드 스크립트(scripts/*.mjs)의 코드 모양을 볼 때 — 주석을 뺀 코드만 본다. 전에는 소스 글자를 잘라 정규식으로 찾아, 주석에 같은 글자가 있으면
 * 코드에서 지워도 통과했다(리뷰 2026-10-01: 레시피 주석의 '(상한 HOT_WAIT_MS)'). TypeScript 파서로 읽어 이름으로 찾고, 주석 없이 다시 찍은 글자를 준다.
 * 다시 찍은 글자는 모양이 고르다(들여쓰기 4칸 · 숫자 구분자 없음 — 10_000 은 10000). 판단 논리는 lib 의 순수 함수로 옮겨 동작으로 시험하고,
 * 이것은 스크립트가 그 함수를 부르는지(얇은 호출부)만 본다.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

export interface ScriptCode {
  /** 파일 전체(주석 없음) */
  code: string;
  /** 맨 위 함수 선언 하나(이름으로) */
  fn(name: string): string;
  /** 맨 위 const 선언 하나(이름으로) — 선언 전체 */
  constant(name: string): string;
  /** const NAME = ["…", …] 의 문자열들 */
  stringArray(name: string): string[];
  /** const RECIPES = { … } 의 레시피 이름(소스 순서) */
  recipeIds: string[];
  /** 레시피 하나 */
  recipe(id: string): string;
  /** 맨 위 문장 가운데 (주석 없는) 글자가 head 로 시작하는 첫 문장 */
  statement(head: string): string;
}

export function scriptCode(url: URL): ScriptCode {
  const src = readFileSync(url, "utf8");
  const sf = ts.createSourceFile(url.pathname, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const printer = ts.createPrinter({ removeComments: true });
  const print = (n: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, n, sf);
  const top = sf.statements;
  const decl = (name: string) => {
    for (const s of top) {
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return { stmt: s, d };
    }
    throw new Error(`${url.pathname}: const ${name} 없음`);
  };
  const recipes = (() => {
    const init = decl("RECIPES").d.initializer;
    if (!init || !ts.isObjectLiteralExpression(init)) throw new Error("RECIPES 가 객체 리터럴이 아님");
    const out = new Map<string, ts.Node>();
    for (const p of init.properties) {
      const n = p.name;
      if (n && (ts.isIdentifier(n) || ts.isStringLiteral(n))) out.set(n.text, p);
    }
    return out;
  })();
  return {
    code: printer.printFile(sf),
    fn(name) {
      const f = top.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
      if (!f) throw new Error(`${url.pathname}: function ${name} 없음`);
      return print(f);
    },
    constant: (name) => print(decl(name).stmt),
    stringArray(name) {
      const init = decl(name).d.initializer;
      if (!init || !ts.isArrayLiteralExpression(init)) throw new Error(`${name} 이 배열 리터럴이 아님`);
      return init.elements.filter(ts.isStringLiteral).map((e) => e.text);
    },
    recipeIds: [...recipes.keys()],
    recipe(id) {
      const r = recipes.get(id);
      if (!r) throw new Error(`RECIPES.${id} 없음`);
      return print(r);
    },
    statement(head) {
      const s = top.map(print).find((t) => t.startsWith(head));
      if (s == null) throw new Error(`${url.pathname}: '${head}' 로 시작하는 문장 없음`);
      return s;
    },
  };
}

/** 공백을 하나로(여러 줄 코드를 한 줄 기대값과 견줄 때) */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
