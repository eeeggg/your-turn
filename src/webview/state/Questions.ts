import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import type { Action } from './RootState';
import type { Transition } from './Store';

type Question = Extract<ExtensionToWebviewMessage, { type: 'questions' }>['questions'][number];
type Draft = NonNullable<Question['draft']>;
type Value = Draft[string];
interface QuestionItem {
  question: Question;
  draft: Draft;
  errors: Readonly<Record<string, string>>;
  submitting: boolean;
}
export interface QuestionsState {
  readonly items: readonly QuestionItem[];
  readonly requestedOpen: { readonly interactionId: string } | null;
}
export type QuestionAction =
  | { type: 'questionFieldEdited'; interactionId: string; name: string; value: Value }
  | { type: 'questionFieldCleared'; interactionId: string; name: string }
  | { type: 'questionSubmitted'; interactionId: string }
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
      changed = { ...item, errors: action.errors, submitting: false };
      break;
    case 'questionFieldEdited':
    case 'questionFieldCleared': {
      if (!item.question.fields.some((field) => field.name === action.name)) { return { state, outgoing: [] }; }
      const draft = action.type === 'questionFieldCleared'
        ? Object.fromEntries(Object.entries(item.draft).filter(([name]) => name !== action.name))
        : { ...item.draft, [action.name]: action.value };
      const errors = Object.fromEntries(Object.entries(item.errors).filter(([name]) => name !== action.name));
      changed = { ...item, draft, errors };
      outgoing.push({ type: 'questionDraft', interactionId: action.interactionId, draft });
      break;
    }
    case 'questionSubmitted': {
      const content: Record<string, Value> = Object.create(null) as Record<string, Value>;
      const errors: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const field of item.question.fields) {
        const raw = Object.hasOwn(item.draft, field.name) ? item.draft[field.name] : undefined;
        if (raw === undefined) {
          if (field.required) { errors[field.name] = 'Required'; }
          continue;
        }
        if (field.kind === 'number' || field.kind === 'integer') {
          const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
          if (!Number.isFinite(value)) { errors[field.name] = 'Enter a number'; }
          else if (field.kind === 'integer' && !Number.isInteger(value)) { errors[field.name] = 'Enter a whole number'; }
          else { content[field.name] = value; }
        } else { content[field.name] = raw; }
      }
      const submitting = Object.keys(errors).length === 0;
      changed = { ...item, errors, submitting };
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
