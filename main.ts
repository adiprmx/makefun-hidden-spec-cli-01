// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output
// and exit codes, safe paths, format detection, line matching at three tiers, unified diffs, SEARCH/REPLACE
// blocks, V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------- section 5: matching lines

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const wsOnly = (s: string): boolean => /^[ \t]*$/.test(s);
const TIER_FN: ((s: string) => string)[] = [(s) => s, trimEndWs, trimBothWs];

/** Positions where `old` occurs in lines[from..to) at tier `tier`. Occurrences may overlap. */
function occurrences(lines: string[], old: string[], from: number, to: number, tier: number): number[] {
  const f = TIER_FN[tier]!;
  const key = old.map(f);
  const out: number[] = [];
  const n = old.length;
  if (n === 0) return out;
  for (let i = from; i + n <= to; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (f(lines[i + j]!) !== key[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..2, or 0 only when strict) at which `old` occurs in lines[from..to). */
function firstTierOcc(lines: string[], old: string[], from: number, to: number, strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, old, from, to, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Tier-2 re-indentation of one new line (section 5). */
function reindent(line: string, f: string, p: string, tier: number): string {
  if (tier !== 2) return line;
  if (line === '' || wsOnly(line)) return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

// ---------------------------------------------------------------- section 3: a file's lines

interface FileLines {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function toFileLines(content: string): FileLines {
  if (content === '') return { lines: [], br: '\n', final: false };
  const nl = content.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && content[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = content.split(br);
  const final = content.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fromFileLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------------------------------------------------------------- hunk / chunk bodies (sections 6 and 8)

type BodyEntry = { kind: 'ctx'; text: string; o: number } | { kind: 'del'; text: string; o: number } | { kind: 'add'; text: string };

interface ParsedBody {
  entries: BodyEntry[];
  oldLines: string[];
  /** a `\` line follows the body's last context or `+` line */
  backslashAfterLastCtxOrAdd: boolean;
  /** a `\` line follows the body's last `+` line */
  backslashAfterLastAdd: boolean;
}

function parseBody(body: string[]): ParsedBody {
  const entries: BodyEntry[] = [];
  const oldLines: string[] = [];
  let lastCtxOrAdd = -1;
  let lastAdd = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l === '') {
      entries.push({ kind: 'ctx', text: '', o: oldLines.length });
      oldLines.push('');
      lastCtxOrAdd = i;
    } else if (l[0] === ' ') {
      const text = l.slice(1);
      entries.push({ kind: 'ctx', text, o: oldLines.length });
      oldLines.push(text);
      lastCtxOrAdd = i;
    } else if (l[0] === '-') {
      const text = l.slice(1);
      entries.push({ kind: 'del', text, o: oldLines.length });
      oldLines.push(text);
    } else if (l[0] === '+') {
      entries.push({ kind: 'add', text: l.slice(1) });
      lastCtxOrAdd = i;
      lastAdd = i;
    }
    // `\` lines are not part of O or N; they only mark the body line before them.
  }
  const after = (idx: number): boolean => idx >= 0 && idx + 1 < body.length && body[idx + 1]!.startsWith('\\');
  return { entries, oldLines, backslashAfterLastCtxOrAdd: after(lastCtxOrAdd), backslashAfterLastAdd: after(lastAdd) };
}

/** The N lines for a match at `pos` at `tier`: context lines as the file's own, `+` lines re-indented. */
function renderNew(body: ParsedBody, fileLines: string[], pos: number, tier: number): string[] {
  const f = leadWs(fileLines[pos] ?? '');
  const p = body.oldLines.length > 0 ? leadWs(body.oldLines[0]!) : '';
  const out: string[] = [];
  for (const e of body.entries) {
    if (e.kind === 'ctx') out.push(fileLines[pos + e.o]!);
    else if (e.kind === 'add') out.push(reindent(e.text, f, p, tier));
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves applied, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** True when `p` is a directory in the tree the edits leave it: it exists on disk as a
      directory (and no edit has replaced it with a file), or it is the parent of a file an
      earlier edit created. Directories are not files: edits read them as missing, and no edit
      may write one (audit section 6 point 6). */
  isDir(p: string): boolean {
    if (this.now.has(p)) return false;
    try {
      if (statSync(p).isDirectory()) return true;
    } catch {
      /* not on disk */
    }
    for (const [q, v] of this.now) {
      if (v !== null && q.startsWith(p + '/')) return true;
    }
    return false;
  }
  /** Throws `exists` when a file cannot be created at `p`: the path already holds a file, is a
      directory, or one of its parents is a file (so the directories it needs cannot be made).
      Without this, the write phase would die on an uncaught EISDIR/EEXIST instead of reporting
      the failure as exit 1 (audit section 5 point 29). */
  assertFree(p: string): void {
    if (this.get(p) !== null || this.isDir(p)) throw new Fail('exists', p);
    const parts = p.split('/');
    for (let k = 1; k < parts.length; k++) {
      if (this.get(parts.slice(0, k).join('/')) !== null) throw new Fail('exists', p);
    }
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      tree.assertFree(p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- section 6: unified diffs

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// Paths in a `diff --git` line may hold spaces (SPEC section 6 puts no restriction on them, and
// section 3 paths allow spaces): split at the first ` b/`, not at whitespace.
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+?)[ \t]*$/;

/** The path of a `--- ` / `+++ ` header line: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

interface UHunk {
  a: number;
  body: string[];
}

interface USection {
  oldPath: string;
  newPath: string;
  isCreate: boolean;
  isDelete: boolean;
  isMove: boolean;
  hunks: UHunk[];
}

/** Parse one section starting at `start` (a `diff --git ` line or a `--- ` line followed by `+++ `). */
function parseUnifiedSection(lines: string[], start: number): { sec: USection; next: number } {
  const n = lines.length;
  let i = start;
  let dgOld: string | null = null;
  let dgNew: string | null = null;
  let hdrOld: string | null = null;
  let hdrNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let newFileMode = false;
  let deletedFileMode = false;
  let havePair = false;
  const hunks: UHunk[] = [];

  if (lines[i]!.startsWith('diff --git ')) {
    const m = DIFF_GIT_RE.exec(lines[i]!);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    dgOld = m[1]!;
    dgNew = m[2]!;
    i++;
  }
  // Header phase: until the first hunk, the next section, or the end of the patch.
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('--- ')) {
      const nx = lines[i + 1];
      if (nx === undefined || !nx.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      if (havePair) break; // a new section starts here
      hdrOld = stripAB(headerPath(line));
      hdrNew = stripAB(headerPath(nx));
      havePair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('diff --git ')) break; // next section
    if (line.startsWith('@@')) break; // first hunk
    if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      newFileMode = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      deletedFileMode = true;
      i++;
      continue;
    }
    i++; // any other header line is ignored
  }
  // Hunks.
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      hunks.push({ a, body });
      continue;
    }
    i++; // outside bodies, non-header lines are ignored
  }
  const oldPath = hdrOld ?? renameFrom ?? dgOld ?? '';
  const newPath = hdrNew ?? renameTo ?? dgNew ?? '';
  const isCreate = oldPath === '/dev/null' || newFileMode;
  const isDelete = newPath === '/dev/null' || deletedFileMode;
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  return { sec: { oldPath, newPath, isCreate, isDelete, isMove, hunks }, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      const { sec, next } = parseUnifiedSection(lines, i);
      edits.push(unifiedSectionEdit(sec, strict));
      i = next;
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`); // a hunk before any section
    } else {
      i++;
    }
  }
  return edits;
}

/** Apply one hunk of a section to `fl`, with `d` the offset of the hunks applied so far. */
function applyUnifiedHunk(fl: FileLines, a: number, body: ParsedBody, d: number, strict: boolean, path: string): { fl: FileLines; nLen: number } {
  const lines = fl.lines;
  const oldLines = body.oldLines;
  if (oldLines.length === 0) {
    // Empty O: insert N after the first A + d lines (all of them when the file has fewer).
    const at = Math.max(0, Math.min(lines.length, a + d));
    const nLines = body.entries.filter((e) => e.kind === 'add').map((e) => e.text);
    const newLines = [...lines.slice(0, at), ...nLines, ...lines.slice(at)];
    let final = fl.final;
    if (at === lines.length) final = !body.backslashAfterLastCtxOrAdd;
    return { fl: { lines: newLines, br: fl.br, final }, nLen: nLines.length };
  }
  const found = firstTierOcc(lines, oldLines, 0, lines.length, strict);
  if (!found) throw new Fail('no-match', path);
  const target = a - 1 + d;
  let pos = found.occ[0]!;
  let bestDist = Math.abs(pos - target);
  for (const q of found.occ) {
    const dist = Math.abs(q - target);
    if (dist < bestDist) {
      pos = q;
      bestDist = dist;
    }
  }
  const nLines = renderNew(body, lines, pos, found.tier);
  const newLines = [...lines.slice(0, pos), ...nLines, ...lines.slice(pos + oldLines.length)];
  let final = fl.final;
  if (pos + oldLines.length === lines.length) final = !body.backslashAfterLastCtxOrAdd;
  return { fl: { lines: newLines, br: fl.br, final }, nLen: nLines.length };
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    if (sec.isCreate && sec.isDelete) return; // no file either way
    if (sec.isCreate) {
      const p = sec.newPath;
      if (!safe(p)) throw new Fail('unsafe', p);
      tree.assertFree(p);
      const plus: string[] = [];
      let lastPlus: ParsedBody | null = null;
      for (const h of sec.hunks) {
        const b = parseBody(h.body);
        for (const e of b.entries) if (e.kind === 'add') plus.push(e.text);
        if (b.entries.some((e) => e.kind === 'add')) lastPlus = b;
      }
      const content = plus.length === 0 ? '' : plus.join('\n') + (!lastPlus!.backslashAfterLastAdd ? '\n' : '');
      tree.now.set(p, content);
      return;
    }
    if (sec.isDelete) {
      const p = sec.oldPath;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.isMove) {
      const o = sec.oldPath;
      const nw = sec.newPath;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(nw)) throw new Fail('unsafe', nw);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      tree.assertFree(nw);
      let fl = toFileLines(before);
      let d = 0;
      for (const h of sec.hunks) {
        const b = parseBody(h.body);
        const r = applyUnifiedHunk(fl, h.a, b, d, strict, o);
        d += r.nLen - b.oldLines.length;
        fl = r.fl;
      }
      tree.now.set(o, null);
      tree.now.set(nw, fromFileLines(fl));
      tree.moves.push([o, nw]);
      return;
    }
    const p = sec.oldPath;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    let fl = toFileLines(before);
    let d = 0;
    for (const h of sec.hunks) {
      const b = parseBody(h.body);
      const r = applyUnifiedHunk(fl, h.a, b, d, strict, p);
      d += r.nLen - b.oldLines.length;
      fl = r.fl;
    }
    tree.now.set(p, fromFileLines(fl));
  };
}

// ---------------------------------------------------------------- section 7: SEARCH/REPLACE blocks

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = 0; // index just after the previous block's `>>>>>>> REPLACE` line
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (l.trim() === '') continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      let sep = -1;
      let k = i + 1;
      while (k < n) {
        const t = lines[k]!.trimEnd();
        if (t === '=======') {
          sep = k;
          break;
        }
        if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
        k++;
      }
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      let end = -1;
      k = sep + 1;
      while (k < n) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
        k++;
      }
      if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, old: lines.slice(i + 1, sep), nw: lines.slice(sep + 1, end) });
      prevEnd = end + 1;
      i = end + 1;
    } else {
      i++;
    }
  }
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      tree.assertFree(p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const fl = toFileLines(before);
    const found = firstTierOcc(fl.lines, b.old, 0, fl.lines.length, strict);
    if (!found) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const f = leadWs(fl.lines[pos]!);
    const pp = leadWs(b.old[0]!);
    const nLines = b.nw.map((l) => reindent(l, f, pp, found.tier));
    const newLines = [...fl.lines.slice(0, pos), ...nLines, ...fl.lines.slice(pos + b.old.length)];
    tree.now.set(p, fromFileLines({ lines: newLines, br: fl.br, final: fl.final }));
  };
}

// ---------------------------------------------------------------- section 8: V4A patches

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  updateLine: number;
}

const isBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';
const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Collect one chunk's body lines from `start` (up to, not including, `last`). */
function collectVChunkBody(lines: string[], start: number, last: number): { lines: string[]; next: number; eof: boolean } {
  const body: string[] = [];
  let i = start;
  let eof = false;
  while (i < last) {
    const l = lines[i]!;
    if (isSectionStart(l)) break;
    if (l.trim() === '*** End of File') {
      eof = true;
      i++;
      break;
    }
    if (l.startsWith('@@')) break;
    if (l.trim() === '*** End Patch') break;
    if (isBodyLine(l)) {
      body.push(l);
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return { lines: body, next: i, eof };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const secLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          secLines.push(l.slice(1));
          i++;
        } else if (blank(l)) {
          secLines.push('');
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      sections.push({ kind: 'add', path, moveTo: null, lines: secLines, chunks: [], updateLine: 0 });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [], updateLine: 0 });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          i++;
          const body = collectVChunkBody(lines, i, last);
          i = body.next;
          chunks.push({ anchor: anchor === '' ? null : anchor, body: body.lines, eof: body.eof });
          continue;
        }
        if (isBodyLine(l)) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
          const body = collectVChunkBody(lines, i, last);
          i = body.next;
          chunks.push({ anchor: null, body: body.lines, eof: body.eof });
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
      }
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks, updateLine });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (s.kind === 'add') {
      const p = s.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      tree.assertFree(p);
      tree.now.set(p, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      const p = s.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = s.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (s.moveTo !== null) tree.assertFree(s.moveTo);
    let fl = toFileLines(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const found = firstTierOcc(fl.lines, [ch.anchor], cursor, fl.lines.length, strict);
        if (!found) throw new Fail('no-match', p);
        cursor = found.occ[0]! + 1;
      }
      const body = parseBody(ch.body);
      const oldLines = body.oldLines;
      if (oldLines.length === 0) {
        const nLines = body.entries.filter((e) => e.kind === 'add').map((e) => e.text);
        const at = ch.eof ? fl.lines.length : cursor;
        const newLines = [...fl.lines.slice(0, at), ...nLines, ...fl.lines.slice(at)];
        fl = { lines: newLines, br: fl.br, final: fl.final };
        cursor = at + nLines.length;
        continue;
      }
      let found: { tier: number; occ: number[] } | null = null;
      if (ch.eof) {
        // Only an occurrence ending at the file's last line.
        const pos = fl.lines.length - oldLines.length;
        if (pos >= cursor) {
          const max = strict ? 0 : 2;
          for (let t = 0; t <= max; t++) {
            const occ = occurrences(fl.lines, oldLines, pos, pos + oldLines.length, t);
            if (occ.length > 0) {
              found = { tier: t, occ };
              break;
            }
          }
        }
      } else {
        found = firstTierOcc(fl.lines, oldLines, cursor, fl.lines.length, strict);
      }
      if (!found) throw new Fail('no-match', p);
      const pos = found.occ[0]!;
      const nLines = renderNew(body, fl.lines, pos, found.tier);
      const newLines = [...fl.lines.slice(0, pos), ...nLines, ...fl.lines.slice(pos + oldLines.length)];
      fl = { lines: newLines, br: fl.br, final: fl.final };
      cursor = pos + nLines.length;
    }
    const result = fromFileLines(fl);
    if (s.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(s.moveTo, result);
      tree.moves.push([p, s.moveTo]);
    } else {
      tree.now.set(p, result);
    }
  };
}

// ---------------------------------------------------------------- section 10: order and atomicity

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves: [string, string][] = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const covered = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o, nw] of tree.moves) {
    const oc = changed.get(o);
    const nc = changed.get(nw);
    if (oc !== undefined && nc !== undefined && oc.was !== null && oc.now === null && nc.was === null && nc.now !== null && !covered.has(o) && !covered.has(nw)) {
      rows.push({ key: nw, line: `R ${o} -> ${nw}` });
      covered.add(o);
      covered.add(nw);
    }
  }
  for (const [p, { was, now }] of changed) {
    if (covered.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...changed.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = changed.get(p)!.now;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
