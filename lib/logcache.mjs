// lib/logcache.mjs: a cache of the decoded log and of the tree each receipt's input snapshot names
// (issue #57). readLog decoded every record from Git on every call, and wake walked each stale
// requirement's receipts with two git processes per receipt: a consumer project with 2,370
// records spent about 2 s of a 2.5 s wake there, and both costs grew with the log.
//
// The cache sits in the Git directory, so it is never project content, a scope breach or a
// commit. It is derived and checked: readLog uses it only when its format, Sudus version and ref
// match and its records form one first-parent chain that the ref still extends, and reads the
// rest from Git. A missing, unreadable or mismatched cache is ignored. Wake only reads it (wake is
// read-only); the commands that write state save it after they run. Deleting it is always safe.
// Like the refs it copies, it is not a security boundary: editing it changes what Sudus reads, as
// rewriting refs/sudus/log does.
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { git } from './gitx.mjs';

const FORMAT = 1;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SHA = /^[0-9a-f]{40}$/;

const files = new Map();
export async function cacheFile(cwd) {
  let file = files.get(cwd);
  if (!file) {
    const common = (await git(['rev-parse', '--git-common-dir'], { cwd })).stdout.trim();
    file = join(resolve(cwd, common), 'sudus', 'log-cache.json');
    files.set(cwd, file);
  }
  return file;
}

// The snapshot-to-tree facts this process holds for a project, from the cache or read from Git.
// A snapshot commit never changes, so a fact once read stays true.
const trees = new Map();
export function knownTrees(cwd) {
  let m = trees.get(cwd);
  if (!m) trees.set(cwd, m = new Map());
  return m;
}

// What the cache file held when this process last read or wrote it: its head and tree count.
const onDisk = new Map();
export function cacheUpToDate(cwd, ref, head, treeCount) {
  const d = onDisk.get(cwd);
  return d?.ref === ref && d.head === head && d.trees === treeCount;
}

function usable(c, ref) {
  if (c?.format !== FORMAT || c.version !== VERSION || c.ref !== ref) return false;
  if (!Array.isArray(c.records) || c.records.length === 0 || typeof c.trees !== 'object' || c.trees === null) return false;
  let parent = null;
  for (const r of c.records) {
    if (typeof r !== 'object' || r === null || !SHA.test(r.sha) || r.parent !== parent) return false;
    if (typeof r.kind !== 'string' || typeof r.target !== 'string' || typeof r.payload !== 'object' || r.payload === null) return false;
    parent = r.sha;
  }
  return Object.entries(c.trees).every(([snap, tree]) => SHA.test(snap) && SHA.test(tree));
}

// The cached records of `ref`, oldest first, or null when there is no usable cache. Its trees join
// this process's known trees.
export async function loadCache(cwd, ref) {
  let c;
  try { c = JSON.parse(await readFile(await cacheFile(cwd), 'utf8')); }
  catch (e) { if (e.code || e instanceof SyntaxError) return null; throw e; }
  if (!usable(c, ref)) return null;
  const known = knownTrees(cwd);
  for (const [snap, tree] of Object.entries(c.trees)) known.set(snap, tree);
  onDisk.set(cwd, { ref, head: c.records.at(-1).sha, trees: Object.keys(c.trees).length });
  return c.records;
}

// Writes the cache of `ref`: its records and the trees of their receipts' input snapshots. The
// file is written under a temporary name and renamed, so a reader sees the old cache or the new
// one, never part of one. A Git directory that cannot take the file (read-only, full) keeps the
// old cache, which readers still check; the command that wrote state has succeeded either way.
export async function saveCache(cwd, ref, records, receiptTrees) {
  const file = await cacheFile(cwd);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const body = JSON.stringify({ format: FORMAT, version: VERSION, ref, records, trees: Object.fromEntries(receiptTrees) });
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, body);
    await rename(tmp, file);
    onDisk.set(cwd, { ref, head: records.at(-1).sha, trees: receiptTrees.size });
  } catch (e) {
    if (!e.code) throw e;
    try { await rm(tmp, { force: true }); } catch { /* the temporary file stays; the cache is unchanged */ }
  }
}
