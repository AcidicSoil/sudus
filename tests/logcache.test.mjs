// tests/logcache.test.mjs: the log cache and the batched receipt lookup (issue #57).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loopRepo, mechanismFor } from './helpers/loop.mjs';
import { declare } from '../lib/mechanisms.mjs';
import { check, refreshCache } from '../lib/check.mjs';
import { git } from '../lib/gitx.mjs';
import { readLog } from '../lib/records.mjs';
import { main } from '../lib/cli.mjs';

const RECORDS = new URL('../lib/records.mjs', import.meta.url).href;
const SUDUS = new URL('../bin/sudus.mjs', import.meta.url).pathname;

// A new process, so nothing this one has read carries over.
function run(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, SUDUS_SESSION: 'test-session', ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const logIn = (cwd, env) => JSON.parse(run(cwd, ['--input-type=module', '-e', `import { readLog } from '${RECORDS}'; process.stdout.write(JSON.stringify(await readLog(process.cwd())));`], env));
async function cacheFile(cwd) {
  return join(resolve(cwd, (await git(['rev-parse', '--git-common-dir'], { cwd })).stdout.trim()), 'sudus', 'log-cache.json');
}
// The log as Git alone gives it: read with the cache file out of the way.
async function logFromGit(cwd) {
  const file = await cacheFile(cwd);
  const saved = await readFile(file).catch(() => null);
  await rm(file, { force: true });
  try { return logIn(cwd); } finally { if (saved) await writeFile(file, saved); }
}
// A `git` first on PATH that records each call, then runs the real one.
async function gitSpy() {
  const dir = await mkdtemp(join(tmpdir(), 'sudus-gitspy-'));
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const calls = join(dir, 'calls');
  const hashed = join(dir, 'hashed');
  // hash-object's stdin is its path list: copied aside on its way through.
  await writeFile(join(dir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${calls}'\n`
    + `if [ "$1" = hash-object ]; then tee -a '${hashed}' | '${real}' "$@"; exit $?; fi\nexec '${real}' "$@"\n`);
  await chmod(join(dir, 'git'), 0o755);
  const lines = async (f) => { const c = (await readFile(f, 'utf8').catch(() => '')).split('\n').filter(Boolean); await rm(f, { force: true }); return c; };
  return {
    env: { PATH: `${dir}:${process.env.PATH}` },
    take: () => lines(calls),
    hashed: () => lines(hashed),
  };
}
// n receipts for DEMO-001, each over different input bytes, then input bytes none of them saw:
// wake finds no current receipt and considers every one.
async function staleReceipts(r, n, from = 0) {
  for (let i = from; i < from + n; i++) { await r.write('src/demo.mjs', `console.log("hello");\n// ${i}\n`); await check(r.cwd, 'DEMO-001'); }
  await r.write('src/demo.mjs', 'console.log("hello");\n// none of them\n');
}

test('a later process reads the same log from the cache, extended by the records after it, as from Git (issue #57)', async () => {
  const r = await loopRepo();
  await r.passReq('DEMO-001');
  await refreshCache(r.cwd);
  const saved = JSON.parse(await readFile(await cacheFile(r.cwd), 'utf8'));
  assert.equal(saved.records.at(-1).sha, (await readLog(r.cwd)).at(-1).sha);
  assert.ok(Object.keys(saved.trees).length > 0, 'the receipts\' input trees are cached');
  await r.failReq('DEMO-001');
  await r.escalate('DEMO-001');
  const log = logIn(r.cwd);
  assert.equal(log.length, saved.records.length + 2);
  assert.deepEqual(log, await logFromGit(r.cwd));
});

test('readLog reads a usable cache instead of Git: a marker placed in it comes back', async () => {
  const r = await loopRepo();
  await r.passReq('DEMO-001');
  await refreshCache(r.cwd);
  const file = await cacheFile(r.cwd);
  const c = JSON.parse(await readFile(file, 'utf8'));
  c.records.at(-1).target = 'marker';
  await writeFile(file, JSON.stringify(c));
  assert.equal(logIn(r.cwd).at(-1).target, 'marker');
});

test('a cache that is corrupt, from another version or ref, or not one chain is ignored', async () => {
  const r = await loopRepo();
  await r.passReq('DEMO-001');
  await refreshCache(r.cwd);
  const file = await cacheFile(r.cwd);
  const good = await readFile(file, 'utf8');
  const truth = await logFromGit(r.cwd);
  const marked = (edit) => { const c = JSON.parse(good); c.records.at(-1).target = 'marker'; edit(c); return JSON.stringify(c); };
  for (const bad of [
    good.slice(0, good.length / 2),
    marked((c) => { c.version = '0.0.0'; }),
    marked((c) => { c.format = 2; }),
    marked((c) => { c.ref = 'refs/cairn/log'; }),
    marked((c) => { c.records[1].parent = c.records[0].parent; }),
    marked((c) => { c.trees = { 'not a sha': c.records[0].sha }; }),
  ]) {
    await writeFile(file, bad);
    assert.deepEqual(logIn(r.cwd), truth);
  }
});

test('a cache the log ref no longer extends is ignored: a ref moved back, or rewritten from an earlier record', async () => {
  const r = await loopRepo();
  await r.passReq('DEMO-001');
  await r.failReq('DEMO-001');
  await refreshCache(r.cwd);
  const cached = (await readLog(r.cwd)).length;
  const earlier = (await readLog(r.cwd)).at(-3).sha;
  await git(['update-ref', 'refs/sudus/log', earlier], { cwd: r.cwd });
  assert.equal(logIn(r.cwd).length, cached - 2);
  assert.deepEqual(logIn(r.cwd), await logFromGit(r.cwd));
  await r.escalate('DEMO-001');
  const rewritten = logIn(r.cwd);
  assert.equal(rewritten.length, cached - 1);
  assert.deepEqual(rewritten, await logFromGit(r.cwd));
});

test('wake reads the cache and writes nothing; its git calls do not grow with a stale requirement\'s receipts', async () => {
  const r = await loopRepo();
  await r.passReq('DEMO-001');
  await staleReceipts(r, 3);
  const spy = await gitSpy();
  const cold = run(r.cwd, [SUDUS, 'wake'], spy.env);
  const few = await spy.take();
  await staleReceipts(r, 5, 3);
  assert.equal(run(r.cwd, [SUDUS, 'wake'], spy.env), cold);
  const more = await spy.take();
  assert.equal(more.length, few.length, `${few.length} git calls with 5 receipts, ${more.length} with 10`);
  assert.equal(more.filter((c) => c === 'cat-file').length, few.filter((c) => c === 'cat-file').length);
  // Saved by a command that writes state, the cache leaves wake nothing to read from Git but refs.
  await refreshCache(r.cwd);
  const file = await cacheFile(r.cwd);
  const before = await readFile(file);
  assert.equal(run(r.cwd, [SUDUS, 'wake'], spy.env), cold);
  const warm = await spy.take();
  assert.ok(warm.filter((c) => c === 'cat-file').length < more.filter((c) => c === 'cat-file').length, `${warm.join(' ')}`);
  assert.deepEqual(await readFile(file), before);
});

test('the CLI saves the cache after a command that writes state, and never after wake', async () => {
  const r = await loopRepo();
  await r.passReq('DEMO-001');
  const file = await cacheFile(r.cwd);
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  await main(['wake'], { cwd: r.cwd, ...io });
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.equal(await main(['item', '--backlog', '--slug', 'later', '--from', 'DEMO-001', '--body', 'an idea'], { cwd: r.cwd, ...io }), 0);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).records.at(-1).sha, (await readLog(r.cwd)).at(-1).sha);
});

test('wake hashes a file once, for its workspace check and for every mechanism of the open commitment that declares it', async () => {
  const r = await loopRepo({ reqs: ['DEMO-001', 'DEMO-002'] });
  await r.passReq('DEMO-001');
  await r.passReq('DEMO-002');
  const spy = await gitSpy();
  run(r.cwd, [SUDUS, 'wake'], spy.env);
  const hashed = await spy.hashed();
  assert.ok(['src/demo.mjs', 'flags/DEMO-001', 'flags/DEMO-002'].every((p) => hashed.includes(p)));
  assert.equal(new Set(hashed).size, hashed.length, hashed.join(' '));
});

test('wake runs an identity probe command once, however many mechanisms of the open commitment declare it', async () => {
  const r = await loopRepo({ reqs: ['DEMO-001', 'DEMO-002'] });
  const runs = join(await mkdtemp(join(tmpdir(), 'sudus-probe-')), 'runs');
  const probe = `node -e "require('fs').appendFileSync('${runs}', 'run\\n'); console.log('v1')"`;
  for (const req of r.reqs) await declare(r.cwd, req.toLowerCase(), { ...mechanismFor(req), identity: { tools: { probe }, env: [], image: null } });
  await r.commit('Declare the shared probe');
  await r.passReq('DEMO-001');
  await r.passReq('DEMO-002');
  await rm(runs, { force: true });
  run(r.cwd, [SUDUS, 'wake']);
  assert.equal(await readFile(runs, 'utf8'), 'run\n');
});

test('wake\'s git calls do not grow with the decision lines whose snapshots it verifies', async () => {
  const r = await loopRepo();
  await r.passReq('DEMO-001');
  const spy = await gitSpy();
  const count = async () => { run(r.cwd, [SUDUS, 'wake'], spy.env); return (await spy.take()).length; };
  await r.decide(); await r.commit('One decision');
  const one = await count();
  for (let i = 0; i < 4; i++) await r.decide();
  await r.commit('Five decisions');
  assert.equal(await count(), one);
});
