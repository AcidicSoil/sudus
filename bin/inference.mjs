import { access, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

// Local-only bounded inference transport. It never selects a different backend on failure.
const BACKENDS = new Set(['verdict', 'jeff', 'kev']);
const DIMENSIONS = ['evidence', 'reach', 'contract', 'surface', 'ambiguity'];
const LEVEL_KEYS = ['0', '1', '2', '3', '4'];
const CONFIDENCE_KIND = Object.freeze({ verdict: 'distribution_concentration', jeff: 'distribution_peakedness', kev: 'score_confidence' });
const BODY_CAP = 128 * 1024;
const KEV_4B = Object.freeze({
  model: 'kev-4b-485ace87',
  checkpointRevision: '485ace8703592fcf405488b262449990824cfed1',
  checkpointRepoDir: 'models--jaredpalmer--kev-4b',
  sourceRevision: '5920c5fe4ca8e0970ed4209ac2c9b8e18bea5109',
  base: 'Qwen/Qwen3.5-4B-Base',
  baseRevision: '1001bb4d826a52d1f399e183466143f4da7b741b',
  baseRepoDir: 'models--Qwen--Qwen3.5-4B-Base',
  device: 'cuda', backend: 'torch', dtype: 'bfloat16', temperature: 2.1435469250725863,
});
function defaultHubCache() {
  if (process.env.HF_HUB_CACHE) return resolve(process.env.HF_HUB_CACHE);
  if (process.env.HF_HOME) return resolve(process.env.HF_HOME, 'hub');
  return process.env.HOME ? resolve(process.env.HOME, '.cache', 'huggingface', 'hub') : null;
}
async function readSmallJson(path, cap = 1024 * 1024) {
  const info = await stat(path);
  if (!info.isFile() || info.size > cap) throw new Error('untrusted metadata file');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function verifyKevSnapshot(run, hubCache) {
  try {
    if (!hubCache || typeof run !== 'string' || !isAbsolute(run)) return false;
    const cache = resolve(hubCache), snapshot = resolve(run), rel = relative(cache, snapshot);
    if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) return false;
    if (basename(snapshot) !== KEV_4B.checkpointRevision || basename(dirname(snapshot)) !== 'snapshots') return false;
    const checkpointRepo = dirname(dirname(snapshot));
    if (basename(checkpointRepo) !== KEV_4B.checkpointRepoDir || dirname(checkpointRepo) !== cache) return false;
    const provenance = await readSmallJson(join(snapshot, 'provenance.json'));
    if (provenance?.config?.base !== KEV_4B.base || provenance?.config?.base_revision !== KEV_4B.baseRevision) return false;
    await Promise.all([access(join(snapshot, 'head.pt')), access(join(snapshot, 'adapter_model.safetensors'))]);

    const baseSnapshot = join(cache, KEV_4B.baseRepoDir, 'snapshots', KEV_4B.baseRevision);
    const index = await readSmallJson(join(baseSnapshot, 'model.safetensors.index.json'));
    if (!index?.weight_map || typeof index.weight_map !== 'object' || Array.isArray(index.weight_map)) return false;
    const shards = [...new Set(Object.values(index.weight_map))];
    if (!shards.length || shards.some((name) => typeof name !== 'string' || name.includes('/') || name.includes('\\'))) return false;
    await Promise.all([
      access(join(baseSnapshot, 'config.json')),
      access(join(baseSnapshot, 'tokenizer.json')),
      ...shards.map((name) => access(join(baseSnapshot, name))),
    ]);
    return true;
  } catch { return false; }
}
// The only current public Verdict artifact is GLiClass 151M, not Verdict 2.0.
const VERDICT_151M = Object.freeze({
  model: 'verdict-151m-d2528239',
  checkpoint_sha256: 'd252823994d47a7933217fc86449493299643af6a0c0d83d6bd5a7666d3253ef',
  calibrator_sha256: 'af2a876993148efa0726b6ccf710fe2303897d20c0ce8c7c9036eb50f64d23de',
  max_tokens: 512,
  confidence_kind: 'distribution_concentration',
});
const JEFF_RUNTIME = Object.freeze({
  ok: true, model: 'jeff-gliformer-d0a4e53d', source_revision: '34b32f99a727c47b679adde33f4702a001e02979',
  model_revision: 'd0a4e53d09cebe6bc963dd9be319d4279084bb2d', backend: 'torch', device: 'cuda',
  dtype: 'bfloat16', attn_kernel: 'eager', compiled: false, pad_multiple: 0, temperature: 1, isolate: 'all',
});
export class InferenceError extends Error {
  constructor(klass, status = null) {
    super(`inference: ${klass}${status === null ? '' : ' ' + status}`);
    this.name = 'InferenceError'; this.klass = klass; this.status = status;
  }
}
const invalid = (klass = 'invalid') => { throw new InferenceError(klass); };
const unit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const object = (n) => n !== null && typeof n === 'object' && !Array.isArray(n);
// Bound the bytes actually read, not only the size after buffering a potentially huge body.
async function readBounded(response, cap) {
  const claimed = response.headers?.get?.('content-length');
  if (claimed !== null && claimed !== undefined && /^\d+$/.test(claimed) && Number(claimed) > cap) {
    // A refused response must not hold its connection open, even when no bytes were consumed.
    try { await response.body?.cancel?.(); } catch { /* Refusal wins over cancellation errors. */ }
    invalid('response_oversize');
  }
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = []; let total = 0;
    for await (const part of response.body) {
      const bytes = Buffer.from(part);
      total += bytes.length;
      if (total > cap) invalid('response_oversize');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > cap) invalid('response_oversize');
  return body;
}
function loopback(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname) ||
      u.pathname !== '/v1/systemone' || u.search || u.hash || u.username || u.password) return false;
    return true;
  } catch { return false; }
}
function verify(request, body, backend) {
  if (!object(body) || body.model !== request.model || !object(body.answers)) {
    if (object(body) && body.model !== request.model) invalid('model_mismatch');
    invalid();
  }
  if (Object.keys(body.answers).length !== DIMENSIONS.length) invalid();
  for (const d of DIMENSIONS) {
    const a = body.answers[d];
    if (!a || !object(a.probabilities) || !unit(a.confidence) ||
      typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > 4 ||
      Object.keys(a.probabilities).length !== 5) invalid();
    if (a.abstention_probability !== undefined && !unit(a.abstention_probability)) invalid();
    const expectedKind = CONFIDENCE_KIND[backend];
    if (a.confidence_kind === undefined && backend !== 'verdict') a.confidence_kind = expectedKind;
    if (a.confidence_kind !== expectedKind) invalid();
    if (backend === 'verdict' && !unit(a.abstention_probability)) invalid();
    const vals = LEVEL_KEYS.map((k) => a.probabilities[k]);
    if (vals.some((v) => !unit(v)) || Math.abs(vals.reduce((sum, v) => sum + v, 0) - 1) > 0.02 + 1e-9) invalid();
    const mean = vals.reduce((sum, p, level) => sum + p * level, 0);
    if (Math.abs(a.score - mean) > 0.02) invalid('inconsistent_score');
  }
}
export async function post(request, { backend, endpoint, fetchImpl = globalThis.fetch, timeoutMs = 60000, hubCache = defaultHubCache() } = {}) {
  if (!BACKENDS.has(backend) || !loopback(endpoint) || !object(request) ||
    typeof request.model !== 'string' || !new RegExp(`^${backend}-[a-z0-9][a-z0-9-]*-[0-9a-f]{8,64}$`).test(request.model) || !object(request.questions) ||
    DIMENSIONS.some((d) => request.questions[d]?.type !== 'score') ||
    Object.keys(request.questions).length !== 5 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new InferenceError('config');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let response, raw;
  try {
    const probe = async (path) => {
      const metadata = await fetchImpl(`${new URL(endpoint).origin}${path}`, {
        method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error',
      });
      if (metadata.status !== 200) throw new InferenceError('model_unverified', metadata.status);
      const value = await readBounded(metadata, 8192);
      try { return JSON.parse(value); } catch { throw new InferenceError('model_unverified'); }
    };
    if (backend === 'verdict') {
      const health = await probe('/healthz');
      if (Object.entries(VERDICT_151M).some(([key, val]) => health?.[key] !== val) || request.model !== VERDICT_151M.model || health.ok !== true) {
        throw new InferenceError('model_unverified');
      }
    }
    if (backend === 'jeff') {
      const attested = await probe('/sudus-healthz');
      if (Object.entries(JEFF_RUNTIME).some(([key, val]) => attested?.[key] !== val)) throw new InferenceError('model_unverified');
      const health = await probe('/healthz');
      const stats = await probe('/stats');
      const revision = JEFF_RUNTIME.model_revision;
      const path = stats?.backend?.model;
      const snapshot = typeof path === 'string' && path.match(/[/\\]snapshots[/\\]([0-9a-f]{40})$/);
      if (health?.ok !== true || health.model !== request.model ||
          request.model !== JEFF_RUNTIME.model || !snapshot || snapshot[1] !== revision ||
          stats.temperature !== 1 || stats.backend?.backend !== 'torch' || stats.backend?.device !== 'cuda' ||
          stats.backend?.dtype !== 'bfloat16' || stats.backend?.attn_kernel !== 'eager' || stats.backend?.compiled !== false ||
          stats.backend?.pad_multiple !== 0 || stats.prompt?.instruction_as_name !== true ||
          stats.prompt?.fold_descriptions !== true || stats.prompt?.fold_examples !== false || stats.prompt?.sep !== ': ' ||
          stats.prompt?.noul_mode !== 'yes_no' || stats.prompt?.isolate !== 'all' || stats.prompt?.state_format !== 'kv') {
        throw new InferenceError('model_unverified');
      }
    }
    if (backend === 'kev') {
      // The Sudus launcher fixes and attests every output-affecting runtime knob. The stock Kev
      // model card still supplies the concrete checkpoint path; verify its provenance and every
      // pinned base shard locally before any decision state crosses the loopback socket.
      const attested = await probe('/sudus-healthz');
      const expected = {
        ok: true, model: KEV_4B.model, source_revision: KEV_4B.sourceRevision,
        checkpoint_revision: KEV_4B.checkpointRevision, base_revision: KEV_4B.baseRevision,
        backend: KEV_4B.backend, device: KEV_4B.device, dtype: KEV_4B.dtype, attn: 'sdpa', merge: true,
        lora_scale: 1, temperature: KEV_4B.temperature, cuda_graphs: false, fused: false, date_facts: false,
      };
      if (Object.entries(expected).some(([key, val]) => attested?.[key] !== val)) throw new InferenceError('model_unverified');
      const info = await probe('/v1/models');
      const card = info?.models?.find((m) => m?.name === 'kev-latest' && m.base === KEV_4B.base && typeof m.run === 'string');
      if (request.model !== KEV_4B.model || !card || card.device !== KEV_4B.device || card.backend !== KEV_4B.backend ||
          card.dtype !== KEV_4B.dtype || card.temperature !== KEV_4B.temperature || card.cuda_graphs !== null ||
          !(await verifyKevSnapshot(card.run, hubCache))) {
        throw new InferenceError('model_unverified');
      }
    }
    response = await fetchImpl(endpoint, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: controller.signal, redirect: 'error' });
    if (response.status !== 200) {
      throw new InferenceError(response.status === 409 ? 'abstention' : (response.status === 422 ? 'context' :
        ([429, 503, 529].includes(response.status) ? 'overloaded' : 'http')), response.status);
    }
    raw = await readBounded(response, BODY_CAP);
  } catch (e) {
    if (e instanceof InferenceError) throw e;
    throw new InferenceError(timedOut ? 'timeout' : 'network');
  } finally { clearTimeout(timer); }
  let body;
  try { body = JSON.parse(raw); } catch { throw new InferenceError('malformed'); }
  verify(request, body, backend);
  return { status: 200, model: body.model, body: JSON.stringify(body) };
}
