import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../lib/init.mjs';
import { policyDigest, buildScoreRequest, measure } from '../lib/evaluate.mjs';
import { makeProject } from './helpers/repo.mjs';
import { start } from '../lib/commitment.mjs';
import { readLog } from '../lib/records.mjs';
import { unb64url } from '../lib/canon.mjs';

const conf = (backend = 'verdict') => ({ ...DEFAULT_SETTINGS(null, null), inference: {
  ...DEFAULT_SETTINGS(null, null).inference, enabled: true, backend,
  model: `${backend}-151m-d2528239`, endpoint: 'http://127.0.0.1:8011/v1/systemone',
} });
const answer = () => ({ score: 0, confidence: 0.9, confidence_kind: 'distribution_concentration', abstention_probability: 0.2, ignored_untrusted: 'should-not-persist', probabilities: { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 } });
const reply = (model) => JSON.stringify({ model, answers: Object.fromEntries(['evidence', 'reach', 'contract', 'surface', 'ambiguity'].map((d) => [d, answer()])), usage: { input_tokens: 10, output_tokens: 0 } });
const draft = { commitment: 'auth-tokens', concerns: ['AUTH-003'], question: 'Rotate tokens hourly?', recommendation: 'hourly',
  because: 'observed: node scripts/rotate.mjs prints ok', if_wrong: 'sessions drop', instead: 'daily',
  options: ['hourly', 'daily'], named_paths: [], cited_decisions: [] };
const domain = 'Prefix: AUTH\n\n[AUTH-003] Tokens rotate on a fixed schedule.\nFalsifier: tokens not rotated.\nMechanism: rotate\nStatus: Agreed 2026-09-19\n';

test('backend/model/endpoint changes reset the policy digest and request carries selected model', () => {
  const s = conf();
  assert.notEqual(policyDigest(s), policyDigest(conf('jeff')));
  const other = structuredClone(s); other.inference.endpoint = 'http://127.0.0.1:8002/v1/systemone';
  assert.notEqual(policyDigest(s), policyDigest(other));
  assert.equal(buildScoreRequest(s, { option: {}, five: {} }, 0).model, s.inference.model);
});

test('a local verdict measurement persists the selected source/model and all five scores', async () => {
  const s = conf();
  const p = await makeProject({ settings: { inference: s.inference }, files: {
    'docs/spec/overview.md': '# Keystone\n\n## Spec map\n\n| File | Prefix |\n|---|---|\n| auth.md | AUTH |\n',
    'docs/spec/auth.md': domain,
    'docs/spec/roadmap.md': 'Current: auth-tokens\n\n## auth-tokens\n\nRequirements: AUTH-003\n',
  } });
  try {
    await p.authorize(); await start(p.cwd, 'auth-tokens');
    let options;
    const transport = async (request, opts) => { options = opts; return { status: 200, model: request.model, body: reply(request.model) }; };
    const result = await measure(p.cwd, draft, { transport });
    assert.equal(result.outcome, 'composite');
    assert.equal(options.backend, 'verdict');
    assert.equal(options.endpoint, s.inference.endpoint);
    const records = (await readLog(p.cwd)).slice(-3);
    assert.deepEqual(records.map((r) => r.kind), ['evaluation-intent', 'evaluation-call', 'measurement']);
    for (const r of records) assert.equal(r.payload.source, 'verdict');
    assert.equal(records[2].payload.model, s.inference.model);
    assert.equal(records[2].payload.levels.length, 5);
    const raw = JSON.parse(Buffer.from(unb64url(records[1].payload.raw)).toString());
    assert.equal(raw.answers.evidence.confidence_kind, 'distribution_concentration');
    assert.equal(raw.answers.evidence.abstention_probability, 0.2);
    assert.equal(Object.hasOwn(raw.answers.evidence, 'ignored_untrusted'), false);
  } finally { await p.cleanup(); }
});
