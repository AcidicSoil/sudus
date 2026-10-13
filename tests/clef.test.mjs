import { test } from 'node:test';
import assert from 'node:assert/strict';
import { post, InferenceError } from '../bin/inference.mjs';
import { DEFAULT_SETTINGS } from '../lib/init.mjs';
import { validateSettings } from '../lib/settings.mjs';

const variants = [
  ['clef-flash-9b-8b2e5fd1', 'Cloudflare/clef-flash', '8b2e5fd17c09fd49bc2880b805d5323ec7ff4ff3'],
  ['clef-27b-0b331204', 'Cloudflare/clef', '0b331204bb13fbd2ca93a64df1956f5b55478ce5'],
];
const dims = ['evidence', 'reach', 'contract', 'surface', 'ambiguity'];
const request = (model) => ({ model, state: { task: 'decision' }, questions: Object.fromEntries(dims.map(d => [d, { type: 'score', instructions: d, criteria: ['a', 'b', 'c', 'd', 'e'] }])) });
const output = (model) => ({ model, answers: Object.fromEntries(dims.map(d => [d, { type: 'score', score: 1.3, confidence: 0.5, probabilities: {0: 0.2, 1: 0.3, 2: 0.5, 3: 0, 4: 0} }])), usage: { input_tokens: 200, output_tokens: 0 } });
const config = (model) => ({ ...DEFAULT_SETTINGS(null, null), inference: { ...DEFAULT_SETTINGS(null, null).inference, enabled: true, backend: 'clef', model, endpoint: 'http://127.0.0.1:8800/v1/systemone' }});
const json = (data) => ({status: 200, text: async () => JSON.stringify(data)});

test('both pinned Clef checkpoints are valid locally, aliases and other weights are refused', () => {
  for (const [model] of variants) assert.deepEqual(validateSettings(config(model)), []);
  for (const name of ['clef', 'clef-flash', 'clef-flash-9b-deadbeef', 'clef-custom-9b-8b2e5fd1']) {
    assert.notDeepEqual(validateSettings(config(name)), []);
  }
});
for (const [model, repo, revision] of variants) {
  test(`${model}: verify pinned local metadata before sending the score request`, async () => {
    const calls = [];
    const mock = async (url, init) => {
      calls.push([new URL(url).pathname, init.method, init.body]);
      return json(init.method === 'GET' ? {ok: true, model, repo, revision, device: 'cuda', dtype: 'bfloat16', max_length: 16384} : output(model));
    };
    const got = await post(request(model), { backend: 'clef', endpoint: 'http://127.0.0.1:8800/v1/systemone', fetchImpl: mock });
    assert.deepEqual(calls.map(([path, method])=>[path,method]), [['/sudus-healthz','GET'],['/v1/systemone','POST']]);
    assert.equal(JSON.parse(calls[1][2]).model, model);
    assert.equal(JSON.parse(got.body).answers.evidence.confidence_kind, 'distribution_peakedness');
    calls.length = 0;
    await assert.rejects(post(request(model), { backend: 'clef', endpoint: 'http://127.0.0.1:8800/v1/systemone', fetchImpl: async (url, init) => {
      calls.push(init.method);
      return json({ok: true, model, repo, revision: '0'.repeat(40), device: 'cuda', dtype: 'bfloat16', max_length: 16384});
    }}), e => e instanceof InferenceError && e.klass === 'model_unverified');
    assert.deepEqual(calls, ['GET']);
  });
}
