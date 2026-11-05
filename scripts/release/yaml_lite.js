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
 * Tiny, strict reader for the YAML subset used by the release workflows.
 *
 * Test helper only (zero npm deps). Supported: block mappings, block
 * sequences (including `- key: value` items and compact sequences under a
 * key), plain / single-quoted / double-quoted scalars, literal and folded
 * block scalars (`|`, `|-`, `|+`, `>`, `>-`, `>+`), flow sequences of scalars
 * (`[a, 'b']`), the empty flow mapping `{}`, and `#` comments.
 *
 * Every scalar is returned as a string (no bool/number typing), so tests
 * compare against the literal text in the workflow. Anything outside the
 * subset (tabs, anchors, aliases, tags, flow mappings, multi-line plain
 * scalars, duplicate keys) throws, so a test can never silently read a
 * construct it does not understand.
 */

const fs = require("node:fs");

class YamlLiteError extends Error {}

function fail(lineNo, message) {
  throw new YamlLiteError(`yaml_lite: line ${lineNo + 1}: ${message}`);
}

function isSkippable(line) {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

function isSeqItem(content) {
  return content === "-" || content.startsWith("- ");
}

// Reads a quoted scalar starting at s[0]. Returns { value, end } where `end`
// is the index just past the closing quote.
function readQuoted(s, lineNo) {
  const q = s[0];
  let out = "";
  let i = 1;
  while (i < s.length) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += c;
      i += 1;
      continue;
    }
    if (c === "\\") {
      const n = s[i + 1];
      const map = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", r: "\r", 0: "\0" };
      if (!(n in map)) fail(lineNo, `unsupported escape \\${n}`);
      out += map[n];
      i += 2;
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    out += c;
    i += 1;
  }
  return fail(lineNo, "unterminated quoted scalar");
}

function assertOnlyComment(rest, lineNo) {
  const t = rest.trim();
  if (t !== "" && !t.startsWith("#")) {
    fail(lineNo, `unexpected text after scalar: ${JSON.stringify(t)}`);
  }
}

function stripPlainComment(s) {
  // A comment starts at " #" (or "#" at the very start) outside quotes.
  const idx = s.search(/(^|\s)#/);
  return (idx === -1 ? s : s.slice(0, idx)).trimEnd();
}

function splitFlowItems(inner, lineNo) {
  const items = [];
  let cur = "";
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === "'" || c === '"') {
      const { end } = readQuoted(inner.slice(i), lineNo);
      cur += inner.slice(i, i + end);
      i += end;
      continue;
    }
    if (c === "[" || c === "{") fail(lineNo, "nested flow collections are not supported");
    if (c === ",") {
      items.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  items.push(cur);
  if (items.length === 1 && items[0].trim() === "") return [];
  return items.map((it) => {
    const t = it.trim();
    if (t === "") fail(lineNo, "empty flow sequence item");
    return parseScalar(t, lineNo);
  });
}

function parseScalar(raw, lineNo) {
  const s = raw.trim();
  if (s === "") return null;
  const c = s[0];
  if (c === "'" || c === '"') {
    const { value, end } = readQuoted(s, lineNo);
    assertOnlyComment(s.slice(end), lineNo);
    return value;
  }
  if (c === "[") {
    const body = stripPlainComment(s);
    if (!body.endsWith("]")) fail(lineNo, "unterminated flow sequence");
    return splitFlowItems(body.slice(1, -1), lineNo);
  }
  if (c === "{") {
    if (stripPlainComment(s) === "{}") return {};
    return fail(lineNo, "flow mappings are not supported");
  }
  if (c === "&" || c === "*" || c === "!") {
    return fail(lineNo, "anchors, aliases and tags are not supported");
  }
  if (c === "@" || c === "`") fail(lineNo, `reserved indicator ${c}`);
  const value = stripPlainComment(s);
  if (value === "") return null;
  return value;
}

// Splits `key: rest` at the first `:` followed by space/end, outside quotes.
// Returns null when the text is not a mapping entry.
function splitKey(content, lineNo) {
  if (content[0] === "'" || content[0] === '"') {
    const { value, end } = readQuoted(content, lineNo);
    const after = content.slice(end);
    if (after === ":" || after.startsWith(": ")) {
      return { key: value, rest: after.slice(1) };
    }
    return null;
  }
  if (content.startsWith("#")) return null;
  const m = /:(\s|$)/.exec(content);
  if (!m) return null;
  const key = content.slice(0, m.index);
  if (key.includes(" #")) return null;
  if (/^[[{&*!|>]/.test(key)) return null;
  return { key: key.trimEnd(), rest: content.slice(m.index + 1) };
}

class Parser {
  constructor(text) {
    this.lines = text.replace(/\r\n/g, "\n").split("\n");
    this.i = 0;
  }

  indentOf(lineNo) {
    const line = this.lines[lineNo];
    const m = /^( *)/.exec(line);
    if (line[m[1].length] === "\t") fail(lineNo, "tab indentation is not supported");
    return m[1].length;
  }

  skip() {
    while (this.i < this.lines.length && isSkippable(this.lines[this.i])) this.i += 1;
  }

  atEnd() {
    this.skip();
    return this.i >= this.lines.length;
  }

  parseNode(minIndent) {
    if (this.atEnd()) return null;
    const ind = this.indentOf(this.i);
    if (ind < minIndent) return null;
    const content = this.lines[this.i].slice(ind);
    if (isSeqItem(content)) return this.parseSeq(ind);
    return this.parseMap(ind);
  }

  parseMap(indent) {
    const obj = {};
    for (;;) {
      if (this.atEnd()) break;
      const ind = this.indentOf(this.i);
      if (ind < indent) break;
      if (ind > indent) fail(this.i, "unexpected indentation");
      const content = this.lines[this.i].slice(ind);
      if (isSeqItem(content)) break;
      const entry = splitKey(content, this.i);
      if (!entry) fail(this.i, `expected "key: value", got ${JSON.stringify(content)}`);
      if (Object.prototype.hasOwnProperty.call(obj, entry.key)) {
        fail(this.i, `duplicate key ${JSON.stringify(entry.key)}`);
      }
      const lineNo = this.i;
      this.i += 1;
      obj[entry.key] = this.parseValue(entry.rest, indent, lineNo);
    }
    return obj;
  }

  parseValue(rest, parentIndent, lineNo) {
    const trimmed = rest.trim();
    const header = stripPlainComment(trimmed);
    if (header === "") {
      if (this.atEnd()) return null;
      const ind = this.indentOf(this.i);
      const content = this.lines[this.i].slice(ind);
      if (ind > parentIndent) return this.parseNode(ind);
      if (ind === parentIndent && isSeqItem(content)) return this.parseSeq(ind);
      return null;
    }
    if (/^[|>][-+]?$/.test(header)) return this.parseBlockScalar(header, parentIndent);
    const value = parseScalar(trimmed, lineNo);
    // A plain scalar continued on a more-indented line is not supported.
    if (!this.atEnd() && this.indentOf(this.i) > parentIndent) {
      fail(this.i, "multi-line plain scalars are not supported");
    }
    return value;
  }

  parseBlockScalar(header, parentIndent) {
    const style = header[0];
    const chomp = header[1] || "";
    const body = [];
    let blockIndent = null;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (line.trim() === "") {
        body.push("");
        this.i += 1;
        continue;
      }
      const ind = this.indentOf(this.i);
      if (ind <= parentIndent) break;
      if (blockIndent === null) blockIndent = ind;
      if (ind < blockIndent) fail(this.i, "block scalar line is less indented than its first line");
      body.push(line.slice(blockIndent));
      this.i += 1;
    }
    // Trailing blank lines belong to chomping, not content.
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trailing += 1;
    }
    let text;
    if (style === "|") {
      text = body.join("\n");
    } else {
      text = "";
      for (let k = 0; k < body.length; k += 1) {
        const cur = body[k];
        if (k === 0) {
          text = cur;
          continue;
        }
        const prev = body[k - 1];
        if (cur === "") text += "\n";
        else if (prev === "" || /^\s/.test(cur) || /^\s/.test(prev)) text += (prev === "" ? "" : "\n") + cur;
        else text += " " + cur;
      }
    }
    if (body.length === 0) return "";
    if (chomp === "-") return text;
    if (chomp === "+") return text + "\n".repeat(trailing + 1);
    return text + "\n";
  }

  parseSeq(indent) {
    const arr = [];
    for (;;) {
      if (this.atEnd()) break;
      const ind = this.indentOf(this.i);
      if (ind < indent) break;
      if (ind > indent) fail(this.i, "unexpected indentation in sequence");
      const content = this.lines[this.i].slice(ind);
      if (!isSeqItem(content)) break;
      const after = content === "-" ? "" : content.slice(2);
      const afterTrim = after.trimStart();
      const itemIndent = ind + 2 + (after.length - afterTrim.length);
      if (afterTrim === "" || afterTrim.startsWith("#")) {
        this.i += 1;
        arr.push(this.parseNode(ind + 1));
        continue;
      }
      if (isSeqItem(afterTrim)) fail(this.i, "nested inline sequences are not supported");
      if (splitKey(afterTrim, this.i)) {
        // Re-read this line as the first key of a mapping at itemIndent.
        this.lines[this.i] = " ".repeat(itemIndent) + afterTrim;
        arr.push(this.parseMap(itemIndent));
        continue;
      }
      const lineNo = this.i;
      this.i += 1;
      arr.push(this.parseValue(afterTrim, ind, lineNo));
    }
    return arr;
  }
}

function parse(text) {
  const p = new Parser(text);
  if (p.atEnd()) return null;
  if (p.indentOf(p.i) !== 0) fail(p.i, "document must start at column 0");
  const doc = p.parseNode(0);
  if (!p.atEnd()) fail(p.i, "trailing content that could not be parsed");
  return doc;
}

function parseFile(path) {
  return parse(fs.readFileSync(path, "utf8"));
}

module.exports = { parse, parseFile, YamlLiteError };
