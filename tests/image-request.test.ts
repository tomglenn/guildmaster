import test from 'node:test';
import assert from 'node:assert/strict';
import { imageAttemptAllowance } from '../src/service/image-request.ts';

test('background loop allowance expands for requested image counts, not unrelated numbers', () => {
  assert.equal(imageAttemptAllowance('Include mockup images.'), 10);
  assert.equal(imageAttemptAllowance('Make the second concept more compact.'), 10);
  assert.equal(imageAttemptAllowance('Investigate issue #2138 and include mockup images.'), 10);
  assert.equal(imageAttemptAllowance('Generate 120 high quality landscape images.'), 120);
  assert.equal(imageAttemptAllowance('Generate twelve high quality portrait mockup images.'), 12);
  assert.equal(imageAttemptAllowance('Create twenty-five concepts.'), 25);
  assert.equal(imageAttemptAllowance('Provide one hundred illustrations.'), 100);
  assert.equal(imageAttemptAllowance('Generate 9007199254740992 images.'), 10);
});
