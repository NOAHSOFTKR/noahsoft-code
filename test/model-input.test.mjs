import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModelInput, modelCompletion} from '../dist/model-input.js';

test('structured /model keeps direct IDs and rejects invalid field sets', () => {
  assert.equal(parseModelInput('claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(parseModelInput('Provider: claude Model-Group: opus model:5.5'), 'claude-opus-5-5');
  assert.equal(parseModelInput('MODEL: 5.5 provider: Claude model-group: Opus'), 'claude-opus-5-5');
  for (const value of ['Provider: claude Model: 5.5', 'Provider: other Model-Group: opus Model: 5.5',
    'Provider: claude Model-Group: opus Model: 5.5 Model: 6', 'Provider: claude Model-Group: opus Model: 5.5 unknown: x']) {
    assert.throws(() => parseModelInput(value), /모델 입력 형식/);
  }
});

test('Tab suggestions use known IDs and valid structured fields', () => {
  const ids = ['claude-opus-5-5'];
  assert.equal(modelCompletion('/model claude-op', ids), '/model claude-opus-5-5');
  assert.equal(modelCompletion('/model Provider:claude Model-Group: op', ids), '/model Provider: claude Model-Group: opus Model: 5.5');
  assert.equal(modelCompletion('/model Provider: claude Model-Group: sonnet ', []), '/model Provider: claude Model-Group: sonnet Model: ');
  assert.equal(modelCompletion('/models', ids), undefined);
});
