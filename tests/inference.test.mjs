import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { post, InferenceError } from '../bin/inference.mjs';

const dims = ['evidence', 'reach', 'contract', 'surface', 'ambiguity'];
const request = () => ({ model: 'jeff-gliformer-d0a4e53d', state: { five: { question: 'why?' } }, questions: Object.fromEntries(dims.map((id) => [id, { type: 'score', instructions: `Score ${id}`, criteria: ['a', 'b', 'c', 'd', 'e'] }])) });
const answer = (p = { 0: 0.2, 1: 0.3, 2: 0.5, 3: 0, 4: 0 }) => ({ score: 1.3, confidence: 0.7, probabilities: p });
const body = (over = {}) => ({ model: 'jeff-gliformer-d0a4e53d', answers: Object.fromEntries(dims.map((d) => [d, answer()])), usage: { input_tokens: 5, output_tokens: 0 }, ...over });
const jeffAttestation = { ok: true, model: 'jeff-gliformer-d0a4e53d', source_revision: '34b32f99a727c47b679adde33f4702a001e02979',
  model_revision: 'd0a4e53d09cebe6bc963dd9be319d4279084bb2d', backend: 'torch', device: 'cuda', dtype: 'bfloat16',
  attn_kernel: 'eager', compiled: false, pad_multiple: 0, temperature: 1, isolate: 'all' };
const kevAttestation = { ok: true, model: 'kev-4b-485ace87', source_revision: '5920c5fe4ca8e0970ed4209ac2c9b8e18bea5109',
  checkpoint_revision: '485ace8703592fcf405488b262449990824cfed1', base_revision: '1001bb4d826a52d1f399e183466143f4da7b741b',
  backend: 'torch', device: 'cuda', dtype: 'bfloat16', attn: 'sdpa', merge: true, lora_scale: 1,
  temperature: 2.1435469250725863, cuda_graphs: false, fused: false, date_facts: false };
const verdictBody = () => {
  const result = body({ model: 'verdict-151m-d2528239' });
  for (const answer of Object.values(result.answers)) Object.assign(answer, { confidence_kind: 'distribution_concentration', abstention_probability: 0.1 });
  return result;
};
const fake = (data, status = 200, capture = {}) => async (url, opts) => { capture.url = url; capture.opts = opts; return { status, text: async () => typeof data === 'string' ? data : JSON.stringify(data) }; };
const opts = (fetchImpl, extra = {}) => ({ backend: 'jeff', endpoint: 'http://127.0.0.1:8000/v1/systemone',
  fetchImpl: async (url, init) => {
    if (!extra.passthrough && (!extra.backend || extra.backend === 'jeff') && init.method === 'GET') {
      const path = new URL(url).pathname;
      const data = path === '/sudus-healthz' ? jeffAttestation : path === '/healthz' ? { ok: true, model: 'jeff-gliformer-d0a4e53d' } : {
        backend: { backend: 'torch', model: '/cache/models--knowledgator--gliformer-large-v1/snapshots/d0a4e53d09cebe6bc963dd9be319d4279084bb2d', device: 'cuda', dtype: 'bfloat16', attn_kernel: 'eager', compiled: false, pad_multiple: 0 },
        temperature: 1, prompt: { instruction_as_name: true, fold_descriptions: true, fold_examples: false, sep: ': ', noul_mode: 'yes_no', isolate: 'all', state_format: 'kv' },
      };
      return { status: 200, text: async () => JSON.stringify(data) };
    }
    return fetchImpl(url, init);
  }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'passthrough')) });
const rejects = (p, klass) => assert.rejects(p, (e) => e instanceof InferenceError && e.klass === klass);

test('requires explicit backend and pinned model; never uses a hosted endpoint', async () => {
  await rejects(post(request()), 'config');
  await rejects(post(request(), opts(fake(body()), { backend: 'unknown' })), 'config');
  for (const endpoint of ['https://api.typesafe.ai/v1/systemone', 'http://localhost.evil.test/v1/systemone', 'http://127.0.0.1:8000/other', 'http://u:p@127.0.0.1:8000/v1/systemone']) {
    await rejects(post(request(), opts(fake(body()), { endpoint })), 'config');
  }
  await rejects(post({ ...request(), model: 'jev-latest' }, opts(fake(body()))), 'config');
  await rejects(post({ ...request(), model: 'jeff-unpinned-v1' }, opts(fake(body()))), 'config');
});

test('sends a single unauthenticated local request and retains pinned model identity', async () => {
  const capture = {};
  const res = await post(request(), opts(fake(body(), 200, capture)));
  assert.equal(capture.url, 'http://127.0.0.1:8000/v1/systemone');
  assert.deepEqual(JSON.parse(capture.opts.body), request());
  assert.equal(capture.opts.headers.Authorization, undefined);
  assert.equal(res.model, request().model);
  assert.equal(res.status, 200);
  const normalized = JSON.parse(res.body);
  assert.equal(normalized.answers.reach.score, 1.3);
  assert.equal(normalized.answers.reach.confidence_kind, 'distribution_peakedness');
});


test('rejects a provider response that misstates its confidence statistic', async () => {
  const wrong = body();
  for (const a of Object.values(wrong.answers)) a.confidence_kind = 'correctness_probability';
  await rejects(post(request(), opts(fake(wrong))), 'invalid');
});

test('rejects inconsistent scores, missing dimensions, and malformed distributions', async () => {
  await rejects(post(request(), opts(fake(body({ answers: { evidence: answer() } })))), 'invalid');
  const bad = body(); bad.answers.reach.score = 2.8;
  await rejects(post(request(), opts(fake(bad))), 'inconsistent_score');
  const extra = body(); extra.answers.surplus = answer();
  await rejects(post(request(), opts(fake(extra))), 'invalid');
  const missingLevel = body(); delete missingLevel.answers.evidence.probabilities['4'];
  await rejects(post(request(), opts(fake(missingLevel))), 'invalid');
  const wrongMass = body(); wrongMass.answers.evidence.probabilities['2'] = 0.1;
  await rejects(post(request(), opts(fake(wrongMass))), 'invalid');
  await rejects(post(request(), opts(fake('{'))), 'malformed');
});

test('refuses backend/model changes, failures, and timeout without retry or fallback', async () => {
  await rejects(post(request(), opts(fake(body({ model: 'kev-4b' })))), 'model_mismatch');
  let count = 0;
  await rejects(post(request(), opts(async () => { count++; return { status: 503, text: async () => 'busy' }; })), 'overloaded');
  assert.equal(count, 1);
  await rejects(post(request(), opts(async (_, init) => { await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))); }, { timeoutMs: 5 })), 'timeout');
});

test('never follows a local redirect to another host', async () => {
  let redirectMode;
  await rejects(post(request(), opts(async (_url, init) => {
    redirectMode = init.redirect;
    if (init.redirect === 'error') throw new Error('redirect refused');
    return { status: 302, text: async () => 'redirect' };
  })), 'network');
  assert.equal(redirectMode, 'error');
});

test('explicit model abstention remains a classified unavailable outcome', async () => {
  await rejects(post(request(), opts(fake({ error: 'abstention' }, 409))), 'abstention');
});

test('context exhaustion is a classified unavailable outcome', async () => {
  await rejects(post(request(), opts(fake({ error: 'context limit' }, 422))), 'context');
});

test('Verdict requires pinned health metadata before any decision state is sent', async () => {
  const r = { ...request(), model: 'verdict-151m-d2528239' };
  const calls = [];
  const health = { ok: true, model: r.model, checkpoint_sha256: 'd252823994d47a7933217fc86449493299643af6a0c0d83d6bd5a7666d3253ef',
    calibrator_sha256: 'af2a876993148efa0726b6ccf710fe2303897d20c0ce8c7c9036eb50f64d23de', max_tokens: 512, confidence_kind: 'distribution_concentration' };
  const client = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    return { status: 200, text: async () => JSON.stringify(init.method === 'GET' ? health : verdictBody()) };
  };
  const response = await post(r, opts(client, { backend: 'verdict' }));
  assert.equal(response.model, r.model);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST']);
  assert.equal(calls[0].body, undefined);
  calls.length = 0;
  await rejects(post(r, opts(async (url, init) => {
    calls.push(init.method);
    return { status: 200, text: async () => JSON.stringify({ ...health, checkpoint_sha256: '0'.repeat(64) }) };
  }, { backend: 'verdict' })), 'model_unverified');
  assert.deepEqual(calls, ['GET'], 'a bad model checkpoint must never receive the decision state');
});

test('Kev verifies pinned checkpoint provenance and a complete pinned base before posting state', async (t) => {
  const r = { ...request(), model: 'kev-4b-485ace87' };
  const root = await mkdtemp(join(tmpdir(), 'sudus-kev-attest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, 'models--jaredpalmer--kev-4b', 'snapshots', '485ace8703592fcf405488b262449990824cfed1');
  const base = join(root, 'models--Qwen--Qwen3.5-4B-Base', 'snapshots', '1001bb4d826a52d1f399e183466143f4da7b741b');
  await mkdir(run, { recursive: true });
  const calls = [];
  const card = { name: 'kev-latest', run, base: 'Qwen/Qwen3.5-4B-Base', device: 'cuda', backend: 'torch', dtype: 'bfloat16',
    temperature: 2.1435469250725863, cuda_graphs: null };
  const client = async (url, init) => {
    calls.push(init.method);
    const path = new URL(url).pathname;
    const data = path === '/sudus-healthz' ? kevAttestation : init.method === 'GET' ? { models: [card] } : body({ model: r.model });
    return { status: 200, text: async () => JSON.stringify(data) };
  };
  await rejects(post(r, opts(client, { backend: 'kev', hubCache: root })), 'model_unverified');
  assert.deepEqual(calls, ['GET', 'GET'], 'missing local provenance must fail before state is posted');

  await writeFile(join(run, 'provenance.json'), JSON.stringify({ config: {
    base: 'Qwen/Qwen3.5-4B-Base', base_revision: '1001bb4d826a52d1f399e183466143f4da7b741b',
  } }));
  await writeFile(join(run, 'head.pt'), 'head');
  await writeFile(join(run, 'adapter_model.safetensors'), 'adapter');
  await mkdir(base, { recursive: true });
  await writeFile(join(base, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { a: 'part-1.safetensors', b: 'part-2.safetensors' } }));
  await writeFile(join(base, 'part-1.safetensors'), 'one');
  calls.length = 0;
  await rejects(post(r, opts(client, { backend: 'kev', hubCache: root })), 'model_unverified');
  assert.deepEqual(calls, ['GET', 'GET'], 'an incomplete pinned base must fail before state is posted');

  await writeFile(join(base, 'part-2.safetensors'), 'two');
  await writeFile(join(base, 'config.json'), '{}');
  await writeFile(join(base, 'tokenizer.json'), '{}');
  calls.length = 0;
  card.temperature = 1;
  await rejects(post(r, opts(client, { backend: 'kev', hubCache: root })), 'model_unverified');
  assert.deepEqual(calls, ['GET', 'GET'], 'runtime calibration knobs must be attested before state is posted');
  card.temperature = 2.1435469250725863;
  calls.length = 0;
  const result = await post(r, opts(client, { backend: 'kev', hubCache: root }));
  assert.equal(result.model, r.model);
  assert.equal(JSON.parse(result.body).answers.evidence.confidence_kind, 'score_confidence');
  assert.deepEqual(calls, ['GET', 'GET', 'POST']);
});

test('Jeff attests the configured snapshot and untempered independent Score path', async () => {
  const r = { ...request(), model: 'jeff-gliformer-d0a4e53d' };
  const calls = [];
  const info = { backend: { backend: 'torch', model: '/cache/models--knowledgator--gliformer-large-v1/snapshots/d0a4e53d09cebe6bc963dd9be319d4279084bb2d', device: 'cuda', dtype: 'bfloat16', attn_kernel: 'eager', compiled: false, pad_multiple: 0 }, temperature: 1,
    prompt: { instruction_as_name: true, fold_descriptions: true, fold_examples: false, sep: ': ', noul_mode: 'yes_no', isolate: 'all', state_format: 'kv' } };
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(init.method + ' ' + path);
    const data = path === '/sudus-healthz' ? jeffAttestation : path === '/healthz' ? { ok: true, model: r.model } :
      path === '/stats' ? info : body({ model: r.model });
    return { status: 200, text: async () => JSON.stringify(data) };
  };
  const result = await post(r, opts(fetcher, { passthrough: true }));
  assert.equal(result.model, r.model);
  assert.deepEqual(calls, ['GET /sudus-healthz', 'GET /healthz', 'GET /stats', 'POST /v1/systemone']);
  calls.length = 0;
  info.temperature = 3.2;
  await rejects(post(r, opts(fetcher, { passthrough: true })), 'model_unverified');
  assert.deepEqual(calls, ['GET /sudus-healthz', 'GET /healthz', 'GET /stats']);
  info.temperature = 1; info.backend.device = 'cpu'; calls.length = 0;
  await rejects(post(r, opts(fetcher, { passthrough: true })), 'model_unverified');
  assert.deepEqual(calls, ['GET /sudus-healthz', 'GET /healthz', 'GET /stats']);
});

test('Verdict cannot omit abstention mass or claim its confidence is correctness probability', async () => {
  const r = { ...request(), model: 'verdict-151m-d2528239' };
  const health = { ok: true, model: r.model, checkpoint_sha256: 'd252823994d47a7933217fc86449493299643af6a0c0d83d6bd5a7666d3253ef',
    calibrator_sha256: 'af2a876993148efa0726b6ccf710fe2303897d20c0ce8c7c9036eb50f64d23de', max_tokens: 512, confidence_kind: 'distribution_concentration' };
  const run = (response) => post(r, opts(async (_url, init) => ({ status: 200, text: async () => JSON.stringify(init.method === 'GET' ? health : response) }), { backend: 'verdict' }));
  const missingMass = body({ model: r.model });
  await rejects(run(missingMass), 'invalid');
  const mislabelled = body({ model: r.model });
  for (const answer of Object.values(mislabelled.answers)) {
    answer.abstention_probability = 0.1;
    answer.confidence_kind = 'correctness_probability';
  }
  await rejects(run(mislabelled), 'invalid');
  for (const answer of Object.values(mislabelled.answers)) answer.confidence_kind = 'distribution_concentration';
  assert.equal((await run(mislabelled)).model, r.model);
});

test('HTTP errors are classified without buffering their untrusted response body', async () => {
  let read = false;
  await rejects(post(request(), opts(async () => ({ status: 503, text: async () => { read = true; throw new Error('do not read'); } }))), 'overloaded');
  assert.equal(read, false);
});

test('streams and bounds successful responses before accepting the full body', async () => {
  let chunks = 0;
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(100000); chunks++;
      yield Buffer.alloc(40000); chunks++;
      throw new Error('unbounded read');
    },
  };
  await rejects(post(request(), opts(async () => ({ status: 200, body: stream,
    text: async () => { throw new Error('unbounded text()'); } }))), 'response_oversize');
  assert.ok(chunks <= 2);
});
