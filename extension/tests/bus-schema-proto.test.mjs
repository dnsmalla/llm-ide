// M3: the schema validator must look keys up as OWN properties. A plain-object lookup `props[k]` finds
// Object.prototype members (constructor, toString, valueOf, hasOwnProperty, __proto__), which let additional properties
// past `additionalProperties: false`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../routes/bus/schema-validate.mjs';
import { COMMAND_SCHEMA, kindInfo } from '../routes/bus/registry.mjs';

const KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__proto__'];
const parse = (k) => JSON.parse(`{"${k}":1}`); // own property even for __proto__

test('envelope: a prototype-member key is rejected as an additional property', () => {
  for (const k of KEYS) {
    const frame = { ...parse(k), v: 1, kind: 'review', idem: 'idem-12345678', args: {} };
    const problems = validate(COMMAND_SCHEMA, frame);
    assert.ok(problems.some((p) => p.path === `.${k}` && /not allowed/.test(p.message)), `${k}: ${JSON.stringify(problems)}`);
  }
});

test('kinds.review.args: a prototype-member key is rejected as an additional property', () => {
  const info = kindInfo('review');
  for (const k of KEYS) {
    const args = { focus: 'code', projectId: 'proj-1', ...parse(k) };
    const problems = validate(info.args, args, {}, '.args');
    assert.ok(problems.some((p) => p.path === `.args.${k}` && /not allowed/.test(p.message)), `${k}: ${JSON.stringify(problems)}`);
  }
  // nested engine object too
  for (const k of KEYS) {
    const problems = validate(info.args, { focus: 'code', projectId: 'p', engine: { provider: 'anthropic', ...parse(k) } }, {}, '.args');
    assert.ok(problems.some((p) => /not allowed/.test(p.message)), `engine.${k}`);
  }
  assert.deepEqual(validate(info.args, { focus: 'code', projectId: 'proj-1' }, {}, '.args'), [], 'a clean args object still validates');
});

test('required and defs lookups ignore the prototype chain', () => {
  const schema = { type: 'object', required: ['toString', 'constructor'], properties: { toString: { type: 'string' } } };
  const problems = validate(schema, {});
  assert.equal(problems.filter((p) => /required/.test(p.message)).length, 2, 'inherited members do not satisfy required');
  assert.equal(validate({ $ref: '#/$defs/constructor' }, 1, { defs: {} }).some((p) => /unresolved/.test(p.message)), true);
  assert.equal(validate({ $ref: '#/$defs/toString' }, 1, { defs: {} }).some((p) => /unresolved/.test(p.message)), true);
});

test('over HTTP semantics: a crafted JSON body with __proto__ never reaches the executor as valid', () => {
  const body = JSON.parse('{"v":1,"kind":"review","idem":"idem-12345678","args":{"focus":"code","projectId":"p","__proto__":{"x":1}}}');
  const problems = validate(kindInfo('review').args, body.args, {}, '.args');
  assert.ok(problems.length > 0);
});
