import { describe, expect, it } from 'vitest';
import { normalizeForm, validateAnswers } from '@/core/ElicitationForm';
import type { ElicitationProperty, ElicitationSchema } from '@/core/acp/AcpDriver';

describe('elicitation forms', () => {
  it('preserves field descriptions, titled choices and valid false and zero defaults', () => {
    const form = normalizeForm({ title: 'Settings', properties: {
      enabled: { type: 'boolean', default: false },
      count: { type: 'integer', minimum: 0, default: 0 },
      choice: { type: 'string', title: 'Choice', description: 'Pick one', oneOf: [{ const: 'a', title: 'Alpha', description: 'First' }], default: 'b' },
    } });
    expect(form.title).toBe('Settings');
    expect(form.fields.map((field) => [field.name, field.default])).toEqual([['enabled', false], ['count', 0], ['choice', undefined]]);
    expect(form.fields[2]).toMatchObject({ title: 'Choice', description: 'Pick one', choices: [{ value: 'a', title: 'Alpha', description: 'First' }] });
  });

  it('validates typed answers without filling optional fields or confusing empty and absent values', () => {
    const form = normalizeForm({ required: ['name'], properties: {
      name: { type: 'string', minLength: 1 }, flag: { type: 'boolean' }, count: { type: 'number' }, tags: { type: 'array', items: { type: 'string', enum: ['a'] } },
    } });
    expect(validateAnswers(form, { name: 'x', flag: false, count: 0, tags: [] })).toEqual({ content: { name: 'x', flag: false, count: 0, tags: [] } });
    expect(validateAnswers(form, { name: 'x' })).toEqual({ content: { name: 'x' } });
    expect(validateAnswers(form, { name: '', flag: 'false', count: '0', tags: ['b'], extra: 1 })).toEqual({ errors: {
      name: 'Invalid value', flag: 'Invalid value', count: 'Invalid value', tags: 'Invalid value', extra: 'Unknown field',
    } });
    expect(validateAnswers(form, {})).toEqual({ errors: { name: 'Required' } });
  });

  it.each([
    { required: ['missing'] },
    { required: ['future'], properties: { future: { type: 'other' } } },
    { properties: { x: { type: 'string', enum: ['a'], oneOf: [{ const: 'a', title: 'A' }] } } },
    { properties: { x: { type: 'string', pattern: '[' } } },
    { properties: { x: { type: 'number', minimum: 2, maximum: 1 } } },
    { properties: { x: { type: 'array', items: { type: 'other' } } } },
    { properties: { x: { type: 'string', enum: [] } } },
  ] satisfies ElicitationSchema[])('rejects unrenderable schema %j', (schema) => {
    expect(() => normalizeForm(schema)).toThrow('Invalid elicitation schema');
  });

  it('defaults omitted object attributes and omits future optional fields', () => {
    expect(validateAnswers(normalizeForm({}), {})).toEqual({ content: {} });
    const form = normalizeForm({ properties: { future: { type: 'other' }, text: { type: 'string', format: 'future' } } });
    expect(form.fields.map((field) => field.name)).toEqual(['text']);
    expect(validateAnswers(form, { text: 'anything' })).toEqual({ content: { text: 'anything' } });
    expect(validateAnswers(form, { future: 'x' })).toEqual({ errors: { future: 'Unknown field' } });
  });

  it.each([
    [{ type: 'string', minLength: 2, maxLength: 3 }, 'ab', 'a'],
    [{ type: 'string', pattern: '^a+$' }, 'aa', 'ba'],
    [{ type: 'string', format: 'email' }, 'a@example.org', 'not-email'],
    [{ type: 'string', format: 'uri' }, 'https://example.org/a', 'relative'],
    [{ type: 'string', format: 'date' }, '2024-02-29', '2023-02-29'],
    [{ type: 'string', format: 'date-time' }, '2026-10-31T10:30:00Z', '2026-02-30T10:30:00Z'],
    [{ type: 'string', format: 'date-time' }, '2026-10-31T23:59:59+02:00', '2026-10-31T24:00:00Z'],
    [{ type: 'integer', minimum: 0, maximum: 2 }, 0, 1.5],
    [{ type: 'number', minimum: 0, maximum: 2 }, 2, Number.POSITIVE_INFINITY],
    [{ type: 'string', enum: ['a', 'b'] }, 'a', 'Other'],
    [{ type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] }, minItems: 1, maxItems: 2 }, ['a'], ['a', 'a']],
  ] satisfies [ElicitationProperty, unknown, unknown][])('enforces field constraints %j', (schema, valid, invalid) => {
    const form = normalizeForm({ properties: { x: schema } });
    expect(validateAnswers(form, { x: valid })).toEqual({ content: { x: valid } });
    expect(validateAnswers(form, { x: invalid })).toEqual({ errors: { x: 'Invalid value' } });
  });
});
