import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import type { Action } from '@/webview/state/RootState';
import type { Transition } from '@/webview/state/Store';

type Question = Extract<ExtensionToWebviewMessage, { type: 'questions' }>['questions'][number];
type Draft = NonNullable<Question['draft']>;
type Value = Draft[string];
interface QuestionItem {
  question: Question;
  draft: Draft;
  errors: Readonly<Record<string, string>>;
  submitting: boolean;
  confirmingEmpty: boolean;
}
export interface QuestionsState {
  readonly items: readonly QuestionItem[];
  readonly requestedOpen: { readonly interactionId: string } | null;
}
export type QuestionAction =
  | { type: 'questionFieldEdited'; interactionId: string; name: string; value: Value }
  | { type: 'questionFieldCleared'; interactionId: string; name: string }
  | { type: 'questionSubmitted'; interactionId: string }
  | { type: 'questionEmptyConfirmed'; interactionId: string }
  | { type: 'questionEditingContinued'; interactionId: string }
  | { type: 'questionDismissed'; interactionId: string; action: 'decline' | 'cancel' };

export const initialQuestions: QuestionsState = { items: [], requestedOpen: null };
export function updateQuestions(state: QuestionsState, action: Action): Transition<QuestionsState, WebviewToExtensionMessage> {
  if (action.type === 'questionOpen') {
    return { state: state.items.some((item) => item.question.interactionId === action.interactionId)
      ? { ...state, requestedOpen: { interactionId: action.interactionId } } : state, outgoing: [] };
  }
  if (action.type === 'questions') {
    const previous = new Map(state.items.map((item) => [item.question.interactionId, item]));
    return {
      state: {
        ...state,
        items: action.questions.map((question) => {
          const existing = previous.get(question.interactionId);
          return existing ? { ...existing, question } : {
            question,
            draft: question.draft ?? Object.fromEntries(question.fields.flatMap((field) => field.default === undefined ? [] : [[field.name, field.default]])),
            errors: {},
            submitting: false,
            confirmingEmpty: false,
          };
        }),
      },
      outgoing: [],
    };
  }
  switch (action.type) {
    case 'questionFieldEdited':
    case 'questionFieldCleared':
    case 'questionSubmitted':
    case 'questionEmptyConfirmed':
    case 'questionEditingContinued':
    case 'questionDismissed':
    case 'questionErrors': break;
    default: return { state, outgoing: [] };
  }
  const item = state.items.find((entry) => entry.question.interactionId === action.interactionId);
  if (!item || (item.submitting && action.type !== 'questionErrors')) { return { state, outgoing: [] }; }
  const outgoing: WebviewToExtensionMessage[] = [];
  let changed: QuestionItem;
  switch (action.type) {
    case 'questionErrors':
      changed = { ...item, errors: action.errors, submitting: false, confirmingEmpty: false };
      break;
    case 'questionFieldEdited':
    case 'questionFieldCleared': {
      if (!item.question.fields.some((field) => field.name === action.name)) { return { state, outgoing: [] }; }
      const draft = action.type === 'questionFieldCleared'
        ? Object.fromEntries(Object.entries(item.draft).filter(([name]) => name !== action.name))
        : { ...item.draft, [action.name]: action.value };
      const errors = Object.fromEntries(Object.entries(item.errors).filter(([name]) => name !== action.name));
      changed = { ...item, draft, errors, confirmingEmpty: false };
      outgoing.push({ type: 'questionDraft', interactionId: action.interactionId, draft });
      break;
    }
    case 'questionEditingContinued':
      changed = { ...item, confirmingEmpty: false };
      break;
    case 'questionSubmitted':
    case 'questionEmptyConfirmed': {
      if (action.type === 'questionEmptyConfirmed' && !item.confirmingEmpty) { return { state, outgoing: [] }; }
      const { content, errors } = questionAnswers(item);
      const valid = Object.keys(errors).length === 0;
      const confirmingEmpty = valid && Object.keys(content).length === 0 && action.type !== 'questionEmptyConfirmed';
      const submitting = valid && !confirmingEmpty;
      changed = { ...item, errors, submitting, confirmingEmpty };
      if (submitting) { outgoing.push({ type: 'questionResponse', interactionId: action.interactionId, action: 'accept', content }); }
      break;
    }
    case 'questionDismissed':
      changed = { ...item, submitting: true };
      outgoing.push({ type: 'questionResponse', interactionId: action.interactionId, action: action.action });
      break;
  }
  return { state: { ...state, items: state.items.map((entry) => entry === item ? changed : entry) }, outgoing };
}

export function questionAnswers(item: QuestionItem): { content: Record<string, Value>; errors: Record<string, string> } {
  const content: Record<string, Value> = Object.create(null) as Record<string, Value>;
  const errors: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of item.question.fields) {
    const raw = Object.hasOwn(item.draft, field.name) ? item.draft[field.name] : undefined;
    if (raw === undefined) {
      if (field.required) { errors[field.name] = 'Required'; }
      continue;
    }
    let value = raw;
    if (field.kind === 'number' || field.kind === 'integer') {
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(number)) { errors[field.name] = 'Enter a number'; continue; }
      if (field.kind === 'integer' && !Number.isInteger(number)) { errors[field.name] = 'Enter a whole number'; continue; }
      value = number;
    }
    let valid: boolean;
    switch (field.kind) {
      case 'number':
      case 'integer':
        valid = typeof value === 'number' && (field.minimum === null || value >= field.minimum) && (field.maximum === null || value <= field.maximum);
        break;
      case 'boolean': valid = typeof value === 'boolean'; break;
      case 'multiple':
        valid = Array.isArray(value) && value.every((entry) => field.choices?.some((choice) => choice.value === entry))
          && new Set(value).size === value.length && (field.minItems === null || value.length >= field.minItems) && (field.maxItems === null || value.length <= field.maxItems);
        break;
      case 'text':
        valid = typeof value === 'string' && (field.minLength === null || Array.from(value).length >= field.minLength)
          && (field.maxLength === null || Array.from(value).length <= field.maxLength)
          && (field.pattern === null || new RegExp(field.pattern).test(value)) && validFormat(field.format, value)
          && (field.choices === null || field.choices.some((choice) => choice.value === value));
        break;
    }
    if (valid) { content[field.name] = value; }
    else { errors[field.name] = 'Invalid value'; }
  }
  return { content, errors };
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
