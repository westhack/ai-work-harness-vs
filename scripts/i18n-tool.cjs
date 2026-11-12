/*
 * Internationalisation helper for the React webviews.
 *
 *   node scripts/i18n-tool.cjs wrap   Wrap visible JSX strings with tr() and
 *                                     refresh scripts/i18n-terms.json
 *   node scripts/i18n-tool.cjs sync    Generate webview-ui/shared/locales/zh-CN.ts
 *                                     from scripts/i18n-terms.json + i18n-zh.json
 *
 * `wrap` is idempotent: wrapped strings are call expressions, so a second run
 * finds nothing new to change. Translations live in scripts/i18n-zh.json.
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const UI_DIR = path.join(ROOT, "webview-ui");
const TERMS_FILE = path.join(__dirname, "i18n-terms.json");
const ZH_FILE = path.join(__dirname, "i18n-zh.json");
const DICT_FILE = path.join(UI_DIR, "shared", "locales", "zh-CN.ts");
const I18N_MODULE = path.join(UI_DIR, "shared", "i18n");

const UI_ATTRS = new Set([
  "title", "placeholder", "aria-label", "alt", "desc", "description",
  "label", "hint", "helper", "tooltip", "emptyText", "subtitle", "headline",
]);

const TECH_WORDS = new Set([
  "true", "false", "null", "undefined", "none", "auto", "default", "inherit",
  "ltr", "rtl", "json", "html", "css", "xml", "text", "plaintext", "string",
  "number", "boolean", "value", "key", "id", "name", "type", "class", "style",
  "src", "href", "data", "self", "top", "left", "right", "center", "bottom",
  "block", "inline", "flex", "grid", "hidden", "visible", "static", "relative",
  "absolute", "fixed", "sticky", "row", "column", "wrap", "nowrap", "start",
  "end", "before", "after", "small", "medium", "compact", "full", "system",
  "reduced", "first", "last", "all", "any", "each", "next", "prev", "previous",
  "div", "span", "button", "input", "option", "svg", "path", "on", "off",
  "yes", "no", "get", "post", "put", "delete", "patch", "head", "stdio", "sse",
  "http", "https", "cpu", "gpu", "utf", "ascii", "utf8", "utf16",
]);

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  hellip: "…", mdash: "—", ndash: "–", rarr: "→", larr: "←",
  middot: "·", copy: "©", reg: "®", trade: "™", times: "×",
  laquo: "«", raquo: "»", bull: "•", check: "✓", star: "★",
};

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Only wrap strings that read like human-facing copy. */
function translatable(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text.length < 2 || text.length > 200) return false;
  if (!/^[A-Za-z]/.test(text)) return false;
  if (!/[A-Za-z]{2}/.test(text)) return false;
  if (/[{}<>`\\]/.test(text)) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(text)) return false;
  if (TECH_WORDS.has(text)) return false;
  // A single lowercase word is usually an identifier; capitalised words and
  // multi-word phrases are almost always visible labels.
  if (!/[\s.!?:;,'’()\-/&]/.test(text) && /^[a-z]/.test(text)) return false;
  return true;
}

function collectTsxFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsxFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

function collectSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const LABEL_KEYS = new Set([
  "label", "desc", "description", "subtitle", "hint", "headline",
  "sub", "placeholder", "emptyText", "tooltip", "text",
]);

/** Built-in label/description tables are translated at their render site. */
function collectConstantStrings(files, terms) {
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isPropertyAssignment(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "";
        if (LABEL_KEYS.has(key) && translatable(node.initializer.text)) {
          terms.add(node.initializer.text.trim());
        }
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^(t|tr|_tr|translate)$/.test(node.expression.text)
        && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
        terms.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

/** Name the translation function is bound to, or null when not imported yet. */
function importAlias(text) {
  const match = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*shared\/i18n["']/.exec(text);
  if (!match) return null;
  const aliased = /\bt\s+as\s+(\w+)/.exec(match[1]);
  return aliased ? aliased[1] : "t";
}

function pickLocalName(text) {
  for (const candidate of ["tr", "_tr", "translate", "i18nText"]) {
    const re = new RegExp(`\\b${candidate}\\b`);
    if (!re.test(text)) return candidate;
  }
  return "tr";
}

function insertionPoint(sourceFile, text) {
  let lastImportEnd = -1;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) lastImportEnd = statement.end;
  }
  if (lastImportEnd >= 0) return lastImportEnd;
  const first = sourceFile.statements.find((s) => s.pos < s.end);
  return first ? first.getStart(sourceFile) : text.length;
}

function wrapFile(file, terms) {
  const text = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const existingAlias = importAlias(text);
  const local = existingAlias ?? pickLocalName(text);
  const edits = [];

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const raw = node.getText(sourceFile);
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
      if (match) {
        const content = decodeEntities(match[2].replace(/\s+/g, " "));
        // Text following an inline expression may start with punctuation
        // (". Deny list always blocks…"). Keep the punctuation outside tr()
        // and only translate sentence-like remainders, never loose fragments
        // such as "% used (" which read better left in English.
        const prefixMatch = /^(\s*[^A-Za-z\s]+\s*)(?=[A-Za-z])/.exec(content);
        const prefix = prefixMatch ? prefixMatch[1] : "";
        const core = content.slice(prefix.length).trim();
        const sentence = !prefix || (core.length >= 15 && /[.!?]$/.test(core) && core.includes(" "));
        if (sentence && translatable(core)) {
          terms.add(core);
          edits.push({
            start: node.getStart(sourceFile),
            end: node.end,
            text: `${match[1]}${prefix}{${local}(${JSON.stringify(core)})}${match[3]}`,
          });
        }
      }
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sourceFile);
      if (UI_ATTRS.has(name)) {
        const core = decodeEntities(node.initializer.text).trim();
        if (translatable(core)) {
          terms.add(core);
          edits.push({
            start: node.initializer.getStart(sourceFile),
            end: node.initializer.end,
            text: `{${local}(${JSON.stringify(core)})}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!edits.length) return 0;

  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].start < edits[i - 1].end) throw new Error(`Overlapping edits in ${file}`);
  }

  let rebuilt = "";
  let cursor = 0;
  for (const edit of edits) {
    rebuilt += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  rebuilt += text.slice(cursor);

  let next = rebuilt;
  if (!existingAlias) {
    const sourceAfter = ts.createSourceFile(file, rebuilt, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const at = insertionPoint(sourceAfter, rebuilt);
    const rel = path.relative(path.dirname(file), I18N_MODULE).split(path.sep).join("/");
    const specifier = rel.startsWith(".") ? rel : `./${rel}`;
    const alias = local === "t" ? "t" : `t as ${local}`;
    next = `${rebuilt.slice(0, at)}\nimport { ${alias} } from "${specifier}";${rebuilt.slice(at)}`;
  }

  fs.writeFileSync(file, next, "utf8");
  return edits.length;
}

function wrap() {
  const files = collectTsxFiles(UI_DIR).sort();
  const terms = new Set();
  let total = 0;
  let changed = 0;
  for (const file of files) {
    const count = wrapFile(file, terms);
    if (count) { changed++; total += count; }
  }
  collectConstantStrings(collectSourceFiles(UI_DIR), terms);
  collectConstantStrings([path.join(ROOT, "src", "shared", "i18n.ts")], terms);
  const sorted = [...terms].sort((a, b) => a.localeCompare(b, "en"));
  const previous = fs.existsSync(TERMS_FILE) ? JSON.parse(fs.readFileSync(TERMS_FILE, "utf8")) : [];
  const merged = [...new Set([...previous, ...sorted])].sort((a, b) => a.localeCompare(b, "en"));
  fs.writeFileSync(TERMS_FILE, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(`wrapped ${total} strings in ${changed} files; ${merged.length} unique terms -> ${path.relative(ROOT, TERMS_FILE)}`);
}

function sync() {
  if (!fs.existsSync(TERMS_FILE)) throw new Error("Run `node scripts/i18n-tool.cjs wrap` first.");
  const terms = JSON.parse(fs.readFileSync(TERMS_FILE, "utf8"));
  const translations = fs.existsSync(ZH_FILE) ? JSON.parse(fs.readFileSync(ZH_FILE, "utf8")) : {};
  const lines = [
    "/*",
    " * Simplified Chinese UI dictionary for AiWorkHarness. Generated by",
    " * `node scripts/i18n-tool.cjs sync` — edit scripts/i18n-zh.json instead.",
    " *",
    " * Keys are the English source strings used at the call site, so the English",
    " * build needs no dictionary and untranslated strings fall back to English.",
    " */",
    "",
    "export const zhCN: Record<string, string> = {",
  ];
  let translated = 0;
  for (const term of terms) {
    const value = translations[term];
    if (typeof value === "string" && value && value !== term) {
      lines.push(`  ${JSON.stringify(term)}: ${JSON.stringify(value)},`);
      translated++;
    }
  }
  lines.push("};", "");
  fs.writeFileSync(DICT_FILE, lines.join("\n"), "utf8");
  console.log(`wrote ${translated}/${terms.length} translations -> ${path.relative(ROOT, DICT_FILE)}`);
}

const command = process.argv[2];
if (command === "wrap") wrap();
else if (command === "sync") sync();
else {
  console.error("Usage: node scripts/i18n-tool.cjs <wrap|sync>");
  process.exit(1);
}
