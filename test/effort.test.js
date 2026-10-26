import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampBoxEffort } from '../src/effort.js';

test('1. {"model":"m","messages":[]} -> clamped false, same Buffer', () => {
  const obj = { model: 'm', messages: [] };
  const body = Buffer.from(JSON.stringify(obj));
  const result = clampBoxEffort(body);
  assert.equal(result.clamped, false);
  assert.equal(result.body, body);
});

test('2. {"model":"m","output_config":{"effort":"max"},"messages":[{"role":"user","content":"hi"}]} -> clamped true, effort high', () => {
  const obj = { model: 'm', output_config: { effort: 'max' }, messages: [{ role: 'user', content: 'hi' }] };
  const body = Buffer.from(JSON.stringify(obj));
  const result = clampBoxEffort(body);
  assert.equal(result.clamped, true);
  const parsed = JSON.parse(result.body.toString('utf8'));
  assert.deepStrictEqual(parsed.output_config.effort, 'high');
});

test('3. {"model":"m","output_config":{"effort":"xhigh"},"messages":[{"role":"user","content":"hi"}]} -> clamped true, effort high', () => {
  const obj = { model: 'm', output_config: { effort: 'xhigh' }, messages: [{ role: 'user', content: 'hi' }] };
  const body = Buffer.from(JSON.stringify(obj));
  const result = clampBoxEffort(body);
  assert.equal(result.clamped, true);
  const parsed = JSON.parse(result.body.toString('utf8'));
  assert.deepStrictEqual(parsed.output_config.effort, 'high');
});

test('4. effort "high", "medium", "low" -> clamped false', () => {
  for (const effort of ['high', 'medium', 'low']) {
    const obj = { output_config: { effort } };
    const body = Buffer.from(JSON.stringify(obj));
    const result = clampBoxEffort(body);
    assert.equal(result.clamped, false);
  }
});

test('5. effort "MAX" -> clamped false', () => {
  const obj = { output_config: { effort: 'MAX' } };
  const body = Buffer.from(JSON.stringify(obj));
  const result = clampBoxEffort(body);
  assert.equal(result.clamped, false);
});

test('6. {"output_config":{"effort":"low"},"messages":[{"content":[{"type":"tool_use","input":{"output_config":{"effort":"max"},"effort":"xhigh"}}]}]} -> clamped false', () => {
  const obj = {
    output_config: { effort: 'low' },
    messages: [{
      content: [{
        type: 'tool_use',
        input: { output_config: { effort: 'max' }, effort: 'xhigh' }
      }]
    }]
  };
  const body = Buffer.from(JSON.stringify(obj));
  const result = clampBoxEffort(body);
  assert.equal(result.clamped, false);
});

test('7. {"reasoning_effort":"max"} -> {"reasoning_effort":"high"}, clamped true', () => {
  const obj = { reasoning_effort: 'max' };
  const body = Buffer.from(JSON.stringify(obj));
  const result = clampBoxEffort(body);
  assert.equal(result.clamped, true);
  assert.deepStrictEqual(JSON.parse(result.body.toString('utf8')), { reasoning_effort: 'high' });
});

test('8. {"a":[{"reasoning_effort":"xhigh"},{"b":{"reasoning_effort":"max"}}],"reasoning_effort":"low"} -> clamped true', () => {
  const obj = {
    a: [{ reasoning_effort: 'xhigh' }, { b: { reasoning_effort: 'max' } }],
    reasoning_effort: 'low'
  };
  const body = Buffer.from(JSON.stringify(obj));
  const result = clampBoxEffort(body);
  assert.equal(result.clamped, true);
  const expected = {
    a: [{ reasoning_effort: 'high' }, { b: { reasoning_effort: 'high' } }],
    reasoning_effort: 'low'
  };
  assert.deepStrictEqual(JSON.parse(result.body.toString('utf8')), expected);
});

test('9. {"reasoning_effort":{"reasoning_effort":"max"}} -> clamped true; {"reasoning_effort":5} -> clamped false', () => {
  const obj1 = { reasoning_effort: { reasoning_effort: 'max' } };
  const body1 = Buffer.from(JSON.stringify(obj1));
  const result1 = clampBoxEffort(body1);
  assert.equal(result1.clamped, true);
  assert.deepStrictEqual(JSON.parse(result1.body.toString('utf8')), { reasoning_effort: { reasoning_effort: 'high' } });

  const obj2 = { reasoning_effort: 5 };
  const body2 = Buffer.from(JSON.stringify(obj2));
  const result2 = clampBoxEffort(body2);
  assert.equal(result2.clamped, false);
});

test('10. {"output_config":["max"]} and {"output_config":"max"} -> clamped false', () => {
  const obj1 = { output_config: ['max'] };
  const body1 = Buffer.from(JSON.stringify(obj1));
  const result1 = clampBoxEffort(body1);
  assert.equal(result1.clamped, false);

  const obj2 = { output_config: 'max' };
  const body2 = Buffer.from(JSON.stringify(obj2));
  const result2 = clampBoxEffort(body2);
  assert.equal(result2.clamped, false);
});

test('11. Raw text: output_config: max { -> clamped false', () => {
  const body = Buffer.from('output_config: max {');
  const result = clampBoxEffort(body);
  assert.equal(result.clamped, false);
  assert.equal(result.body, body);
});

test('12. Raw text: "output_config" (root is JSON string) -> clamped false; [{"reasoning_effort":"max"}] (root is array) -> clamped true', () => {
  const body1 = Buffer.from(JSON.stringify('output_config'));
  const result1 = clampBoxEffort(body1);
  assert.equal(result1.clamped, false);
  assert.equal(result1.body, body1);

  const body2 = Buffer.from(JSON.stringify([{ reasoning_effort: 'max' }]));
  const result2 = clampBoxEffort(body2);
  assert.equal(result2.clamped, true);
  assert.deepStrictEqual(JSON.parse(result2.body.toString('utf8')), [{ reasoning_effort: 'high' }]);
});

test('13. Raw text with large numbers and precise floats -> clamped true and exact text preserved', () => {
  // We need to use JSON.rawJSON for the numbers to be preserved during stringify
  // because we're simulating the behavior of JSON.parse with the reviver.
  // Since we can't easily create a rawJSON object without a real JSON.parse,
  // we'll construct the buffer with the literal text.
  const text = '{"output_config":{"effort":"max"},"id":12345678901234567890,"f":0.1000000000000000055511151231257827,"n":1.0,"e":1E5}';
  const body = Buffer.from(text);

  // However, for clampBoxEffort to work, we need to make sure the reviver actually
  // catches these and uses JSON.rawJSON.
  // In a real scenario, JSON.parse(text, keepNumberText) will do this.
  // Let's test it.
  const result = clampBoxEffort(body);
  assert.equal(result.clamped, true);

  const resText = result.body.toString('utf8');
  assert.ok(resText.includes('12345678901234567890'));
  assert.ok(resText.includes('0.1000000000000000055511151231257827'));
  assert.ok(resText.includes('1.0'));
  assert.ok(resText.includes('1E5'));
});

test('14. {"output_config":{"effort":"max"},"text":"héllo ✓ 日本 😀"} -> text preserved', () => {
  const obj = { output_config: { effort: 'max' }, text: 'héllo ✓ 日本 😀' };
  const body = Buffer.from(JSON.stringify(obj));
  const result = clampBoxEffort(body);
  assert.equal(result.clamped, true);
  assert.strictEqual(JSON.parse(result.body.toString('utf8')).text, 'héllo ✓ 日本 😀');
});

test('15. Result of test 2 is compact JSON', () => {
  const obj = { model: 'm', output_config: { effort: 'max' }, messages: [{ role: 'user', content: 'hi' }] };
  const body = Buffer.from(JSON.stringify(obj));
  const result = clampBoxEffort(body);
  // result.body should be compact JSON.
  // JSON.stringify(root) by default produces compact JSON.
  // Let's verify it doesn't have spaces where they aren't expected.
  // The test says "no newline character and no ': '".
  const resText = result.body.toString('utf8');
  assert.ok(!resText.includes('\n'));
  assert.ok(!resText.includes(': '));
});
