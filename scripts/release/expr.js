/**
 * @license
 * Copyright 2026 The Keras Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

/**
 * Evaluator for the subset of GitHub Actions expressions used in the release
 * workflows. Test helper only: lets tests evaluate the literal `if:` strings
 * read from the YAML instead of a hand-maintained JS mirror.
 *
 * Supported: `==`, `!=`, `&&`, `||`, `!`, parentheses, string literals
 * ('...' with '' escape), `true`, `false`, `null`, integer literals, property
 * paths (`needs.generated-tests.result`, `inputs.dry_run`, `github.ref`, ...)
 * and the status functions `always()`, `success()`, `failure()`,
 * `cancelled()`. Semantics follow the GitHub docs: `&&` / `||` return an
 * operand (not a boolean), `==` is loose (mismatched types compare as
 * numbers), and string equality ignores case. A path whose root is not in the
 * supplied context throws, so a typo such as `input.dry_run` fails the test
 * instead of evaluating to null.
 */

class ExprError extends Error {}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "&&", "||"].includes(two)) {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (c === "!" || c === "(" || c === ")" || c === ",") {
      tokens.push({ t: c === "!" ? "op" : c, v: c });
      i += 1;
      continue;
    }
    if (c === "'") {
      let out = "";
      let j = i + 1;
      for (;;) {
        if (j >= src.length) throw new ExprError("unterminated string literal");
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            out += "'";
            j += 2;
            continue;
          }
          break;
        }
        out += src[j];
        j += 1;
      }
      tokens.push({ t: "lit", v: out });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+/.exec(src.slice(i));
    if (num) {
      tokens.push({ t: "lit", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*/.exec(src.slice(i));
    if (ident) {
      const word = ident[0];
      if (word === "true") tokens.push({ t: "lit", v: true });
      else if (word === "false") tokens.push({ t: "lit", v: false });
      else if (word === "null") tokens.push({ t: "lit", v: null });
      else tokens.push({ t: "path", v: word });
      i += word.length;
      continue;
    }
    throw new ExprError(`unsupported character ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
}

// AST: {k:"lit",v} {k:"path",v} {k:"call",name} {k:"not",e} {k:"bin",op,l,r}
function parseTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  function primary() {
    const tok = take();
    if (!tok) throw new ExprError("unexpected end of expression");
    if (tok.t === "lit") return { k: "lit", v: tok.v };
    if (tok.t === "(") {
      const e = orExpr();
      const close = take();
      if (!close || close.t !== ")") throw new ExprError("missing )");
      return e;
    }
    if (tok.t === "path") {
      if (peek() && peek().t === "(") {
        take();
        const close = take();
        if (!close || close.t !== ")") throw new ExprError(`only zero-argument calls are supported: ${tok.v}`);
        if (!["always", "success", "failure", "cancelled"].includes(tok.v)) {
          throw new ExprError(`unsupported function ${tok.v}()`);
        }
        return { k: "call", name: tok.v };
      }
      return { k: "path", v: tok.v };
    }
    throw new ExprError(`unexpected token ${JSON.stringify(tok.v)}`);
  }

  function unary() {
    if (peek() && peek().t === "op" && peek().v === "!") {
      take();
      return { k: "not", e: unary() };
    }
    return primary();
  }

  function eqExpr() {
    let l = unary();
    while (peek() && peek().t === "op" && (peek().v === "==" || peek().v === "!=")) {
      const op = take().v;
      l = { k: "bin", op, l, r: unary() };
    }
    return l;
  }

  function andExpr() {
    let l = eqExpr();
    while (peek() && peek().t === "op" && peek().v === "&&") {
      take();
      l = { k: "bin", op: "&&", l, r: eqExpr() };
    }
    return l;
  }

  function orExpr() {
    let l = andExpr();
    while (peek() && peek().t === "op" && peek().v === "||") {
      take();
      l = { k: "bin", op: "||", l, r: andExpr() };
    }
    return l;
  }

  const ast = orExpr();
  if (pos !== tokens.length) throw new ExprError(`unexpected token ${JSON.stringify(tokens[pos].v)}`);
  return ast;
}

function unwrap(src) {
  const s = src.trim();
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(s);
  return m ? m[1] : s;
}

function parse(src) {
  return parseTokens(tokenize(unwrap(src)));
}

function truthy(v) {
  return !(v === false || v === null || v === undefined || v === "" || v === 0 || Number.isNaN(v));
}

function toNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
  return NaN;
}

function looseEquals(a, b) {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (typeof na === "string" && typeof nb === "string") return na.toLowerCase() === nb.toLowerCase();
  if (typeof na === typeof nb && na !== null && nb !== null) return na === nb;
  if (na === null && nb === null) return true;
  return toNumber(na) === toNumber(nb);
}

function lookup(path, ctx) {
  const parts = path.split(".");
  if (!Object.prototype.hasOwnProperty.call(ctx, parts[0])) {
    throw new ExprError(`unknown context "${parts[0]}" in ${path}`);
  }
  let cur = ctx[parts[0]];
  for (const p of parts.slice(1)) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = Object.prototype.hasOwnProperty.call(cur, p) ? cur[p] : null;
  }
  return cur === undefined ? null : cur;
}

function needsResults(ctx) {
  return Object.values(ctx.needs || {}).map((n) => n && n.result);
}

function evalAst(ast, ctx) {
  switch (ast.k) {
    case "lit":
      return ast.v;
    case "path":
      return lookup(ast.v, ctx);
    case "call":
      if (ast.name === "always") return true;
      if (ast.name === "cancelled") return Boolean(ctx.cancelled);
      if (ast.name === "failure") return needsResults(ctx).some((r) => r === "failure");
      return !ctx.cancelled && needsResults(ctx).every((r) => r === "success");
    case "not":
      return !truthy(evalAst(ast.e, ctx));
    case "bin": {
      if (ast.op === "&&") {
        const l = evalAst(ast.l, ctx);
        return truthy(l) ? evalAst(ast.r, ctx) : l;
      }
      if (ast.op === "||") {
        const l = evalAst(ast.l, ctx);
        return truthy(l) ? l : evalAst(ast.r, ctx);
      }
      const eq = looseEquals(evalAst(ast.l, ctx), evalAst(ast.r, ctx));
      return ast.op === "==" ? eq : !eq;
    }
    default:
      throw new ExprError(`bad node ${ast.k}`);
  }
}

function hasStatusCall(ast) {
  if (ast.k === "call") return true;
  if (ast.k === "not") return hasStatusCall(ast.e);
  if (ast.k === "bin") return hasStatusCall(ast.l) || hasStatusCall(ast.r);
  return false;
}

/** Evaluates an expression and returns its value (not coerced). */
function evaluate(src, ctx) {
  return evalAst(parse(src), ctx);
}

/**
 * Evaluates a job-level `if:` the way the runner does: when the expression
 * contains no status function, GitHub implicitly prepends `success() &&`.
 */
function evaluateJobIf(src, ctx) {
  const ast = parse(src);
  if (!hasStatusCall(ast) && !evalAst({ k: "call", name: "success" }, ctx)) return false;
  return truthy(evalAst(ast, ctx));
}

module.exports = { evaluate, evaluateJobIf, truthy, ExprError };
