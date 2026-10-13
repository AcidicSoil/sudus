import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../lib/init.mjs';
import { validateSettings } from '../lib/settings.mjs';
import { post, InferenceError } from '../bin/inference.mjs';

const dims = ['evidence', 'reach', 'contract', 'surface', 'ambiguity'];
const makeRequest = (model) => ({ model, state: { problem: 'something' }, questions: Object.fromEntries(dims.map(d => [d, { type: 'score', instructions: d, criteria: ['0','1','2','3','4'] }])) });
const makeResponse = (model) => ({ model, answers: Object.fromEntries(dims.map(d => [d, { score: 1.3, confidence: 0.5, probabilities: {0:0.2,1:0.3,2:0.5,3:0,4:0} }])), usage: { input_tokens: 100, output_tokens: 0 } });
const url = 'http://127.0.0.1:8800/v1/systemone';
const httpJson = (body, status=200) => ({ status, text: async () => JSON.stringify(body) });
const settings = model => ({ ...DEFAULT_SETTINGS(null, null), inference: { ...DEFAULT_SETTINGS(null, null).inference, enabled: true, backend: 'system-one', model, endpoint: url } });

test('select a generic System One model without maintaining a hardcoded model registry', () => {
  for (const model of ['clef-flash', 'clef', 'laya-v2', 'local/score-model:revision1']) {
    assert.deepEqual(validateSettings(settings(model)), [], model);
  }
  for (const model of ['', '   ', 'https://evil.com', null]) assert.notDeepEqual(validateSettings(settings(model)), []);
  assert.notDeepEqual(validateSettings({...settings('clef-flash'),inference:{...settings('clef-flash').inference,endpoint:'http://external.example/v1/systemone'}}), []);
});

test('generic System One sends the same request shape to every protocol-compatible model', async () => {
  for (const model of ['clef-flash','clef','any-future-model']) {
    const calls = [];
    const transport = async (target, init) => {
      calls.push({ path:new URL(target).pathname, method: init.method, data: init.body });
      return httpJson(makeResponse(model));
    };
    const result = await post(makeRequest(model), { backend:'system-one', endpoint:url, fetchImpl:transport });
    assert.equal(result.model,model);
    assert.equal(JSON.parse(result.body).answers.evidence.confidence_kind, 'model_reported');
    assert.deepEqual(calls.map(x=>[x.path,x.method]), [['/v1/systemone','POST']]);
    assert.equal(JSON.parse(calls[0].data).model,model);
  }
});

test('generic System One refuses a mismatched response model and invalid score output', async () => {
  const calls=[];
  await assert.rejects(post(makeRequest('clef-flash'), { backend:'system-one', endpoint:url,
    fetchImpl: async (_, init) => { calls.push(init.method); return httpJson(makeResponse('clef')); } }),
  e => e instanceof InferenceError && e.klass==='model_mismatch');
  assert.deepEqual(calls,['POST']);
  await assert.rejects(post(makeRequest('clef-flash'), { backend:'system-one', endpoint:url,
    fetchImpl: async () => httpJson({model:'clef-flash',answers:{evidence:{score:5}}}) }),
  e => e instanceof InferenceError && e.klass==='invalid');
});
