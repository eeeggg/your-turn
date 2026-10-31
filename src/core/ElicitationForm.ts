import { ElicitationError, type ElicitationForm, type ElicitationSchema, type ElicitationValue } from './acp/AcpDriver';

type FormField = ElicitationForm['fields'][number];
type Choice = NonNullable<FormField['choices']>[number];

function invalid(): never { throw new ElicitationError('invalid', 'Invalid elicitation schema'); }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bound(value: unknown, count = false): number | null {
  if (value == null) { return null; }
  if (typeof value !== 'number' || !Number.isFinite(value) || (count && (!Number.isInteger(value) || value < 0))) { invalid(); }
  return value;
}

function choices(values: readonly Choice[]): readonly Choice[] {
  if (values.length === 0) { invalid(); }
  const result = values.map((value) => Object.freeze({ ...value }));
  if (new Set(result.map((choice) => choice.value)).size !== result.length) { invalid(); }
  return Object.freeze(result);
}

export function normalizeForm(schema: ElicitationSchema): ElicitationForm {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  if (required.some((name: string) => !Object.hasOwn(properties, name))) { invalid(); }
  const fields: FormField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const type = property.type;
    if (type === 'other') {
      if (required.includes(name)) { invalid(); }
      continue;
    }
    let options: readonly Choice[] | null = null;
    if (property.type === 'string') {
      if (property.enum != null && property.oneOf != null) { invalid(); }
      if (property.enum != null) { options = choices(property.enum.map((value) => ({ value, title: value, description: null }))); }
      if (property.oneOf != null) { options = choices(property.oneOf.map((option) => ({ value: option.const, title: option.title, description: option.description ?? null }))); }
    }
    if (property.type === 'array') {
      const items = property.items;
      if ('anyOf' in items) {
        options = choices(items.anyOf.map((option) => ({ value: option.const, title: option.title, description: option.description ?? null })));
      } else {
        if (items.type !== 'string') { invalid(); }
        options = choices(items.enum.map((value) => ({ value, title: value, description: null })));
      }
    }
    const field: FormField = {
      name, type, title: property.title ?? null, description: property.description ?? null, required: required.includes(name), choices: options,
      minimum: property.type === 'number' || property.type === 'integer' ? bound(property.minimum) : null,
      maximum: property.type === 'number' || property.type === 'integer' ? bound(property.maximum) : null,
      minLength: property.type === 'string' ? bound(property.minLength, true) : null,
      maxLength: property.type === 'string' ? bound(property.maxLength, true) : null,
      minItems: property.type === 'array' ? bound(property.minItems, true) : null,
      maxItems: property.type === 'array' ? bound(property.maxItems, true) : null,
      pattern: property.type === 'string' ? property.pattern ?? null : null,
      format: property.type === 'string' ? property.format ?? null : null,
    };
    for (const [min, max] of [[field.minimum, field.maximum], [field.minLength, field.maxLength], [field.minItems, field.maxItems]]) {
      if (min != null && max != null && min > max) { invalid(); }
    }
    if (field.pattern !== null) {
      try { new RegExp(field.pattern); } catch { invalid(); }
    }
    const defaultValue = property.default;
    fields.push(Object.freeze(defaultValue != null && validValue(field, defaultValue)
      ? { ...field, default: copyValue(defaultValue) } : field));
  }
  return Object.freeze({ title: schema.title ?? null, description: schema.description ?? null, fields: Object.freeze(fields) });
}

function copyValue(value: ElicitationValue): ElicitationValue {
  return typeof value === 'object' ? Object.freeze([...value]) : value;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) { return false; }
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validFormat(format: string | null, value: string): boolean {
  switch (format) {
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'uri':
      try { new URL(value); return true; } catch { return false; }
    case 'date': return validDate(value);
    case 'date-time': return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value)
      && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
    default: return true;
  }
}

function validValue(field: FormField, value: unknown): boolean {
  switch (field.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'integer':
    case 'number': return typeof value === 'number' && Number.isFinite(value)
      && (field.type !== 'integer' || Number.isInteger(value))
      && (field.minimum === null || value >= field.minimum) && (field.maximum === null || value <= field.maximum);
    case 'string': return typeof value === 'string'
      && (field.minLength === null || Array.from(value).length >= field.minLength) && (field.maxLength === null || Array.from(value).length <= field.maxLength)
      && (field.pattern === null || new RegExp(field.pattern).test(value)) && validFormat(field.format, value)
      && (field.choices === null || field.choices.some((choice) => choice.value === value));
    case 'array': return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string' && field.choices?.some((choice) => choice.value === entry))
      && new Set(value).size === value.length && (field.minItems === null || value.length >= field.minItems) && (field.maxItems === null || value.length <= field.maxItems);
  }
}

export function validateAnswers(form: ElicitationForm, answers: unknown): { content: Readonly<Record<string, ElicitationValue>> } | { errors: Readonly<Record<string, string>> } {
  if (!object(answers)) { return { errors: { '': 'Expected an object' } }; }
  const errors: Record<string, string> = Object.create(null) as Record<string, string>;
  const content: Record<string, ElicitationValue> = Object.create(null) as Record<string, ElicitationValue>;
  for (const name of Object.keys(answers)) {
    if (!form.fields.some((field) => field.name === name)) { errors[name] = 'Unknown field'; }
  }
  for (const field of form.fields) {
    if (!Object.hasOwn(answers, field.name)) {
      if (field.required) { errors[field.name] = 'Required'; }
    } else if (!validValue(field, answers[field.name])) {
      errors[field.name] = 'Invalid value';
    } else {
      content[field.name] = copyValue(answers[field.name] as ElicitationValue);
    }
  }
  return Object.keys(errors).length ? { errors: Object.freeze(errors) } : { content: Object.freeze(content) };
}
