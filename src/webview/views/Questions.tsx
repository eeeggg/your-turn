import { createContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { QuestionsState } from '@/webview/state/Questions';
import { useDispatch, useSelector, useStore } from '@/webview/views/StoreContext';

type Expansion = 'questions' | 'usage' | null;
export const ExpansionContext = createContext<{ open: Expansion; setOpen: (open: Expansion) => void } | null>(null);
type Item = QuestionsState['items'][number];
type Field = Item['question']['fields'][number];
const controlStyle = 'w-full rounded-sm border border-input-border bg-input px-2 py-1 text-input-foreground focus:outline-1 focus:outline-ring';
const buttonStyle = 'cursor-pointer rounded-sm bg-secondary px-2 py-1 text-secondary-foreground hover:bg-secondary-hover focus-visible:outline-1 focus-visible:outline-ring disabled:opacity-40';

export function Questions({ children }: { children: ReactNode }) {
  const items = useSelector((state) => state.questions.items);
  const openRequest = useSelector((state) => state.questions.requestedOpen);
  const store = useStore();
  const [open, setOpen] = useState<Expansion>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const previous = useRef<readonly Item[]>(items);
  const returnFocus = useRef<HTMLElement | null>(null);
  const notification = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLElement>(null);
  const scrolling = useRef<HTMLDivElement>(null);
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const focusAfterRemoval = useRef(false);
  const requestedOpen = useRef(store.getSnapshot().questions.requestedOpen);
  const explicitTarget = useRef<string | null>(null);
  const detailsId = useId();

  const rememberFocus = () => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const restoreFocus = () => {
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected && !target.matches(':disabled') && !surface.current?.contains(target)) {
      target.focus({ preventScroll: true });
      if (document.activeElement === target) { return; }
    }
    notification.current?.focus({ preventScroll: true });
  };
  const close = () => { restoreFocus(); setOpen(null); };
  useLayoutEffect(() => store.subscribe(() => {
    const items = store.getSnapshot().questions.items;
    const request = store.getSnapshot().questions.requestedOpen;
    if (request && request !== requestedOpen.current) {
      requestedOpen.current = request;
      if (open !== 'questions') { rememberFocus(); }
      explicitTarget.current = request.interactionId;
      setCurrent(request.interactionId);
      setOpen('questions');
    }
    const focused = document.activeElement;
    const focusedForm = focused instanceof HTMLElement ? focused.closest('form') : null;
    const removedFocus = focusedForm?.dataset['questionId'];
    focusAfterRemoval.current = removedFocus !== undefined && !items.some((item) => item.question.interactionId === removedFocus);
    if (!items.some((item) => item.question.interactionId === current)) { setCurrent(items[0]?.question.interactionId ?? null); }
    const wasEmpty = previous.current.length === 0;
    previous.current = items;
    if (items.length === 0) {
      if (focusAfterRemoval.current) { restoreFocus(); }
      if (open === 'questions') { setOpen(null); }
    } else if (wasEmpty && open !== 'questions' && !document.hidden && document.activeElement?.id !== 'promptInput') {
      rememberFocus();
      setCurrent(items[0]?.question.interactionId ?? null);
      setOpen('questions');
    }
  }), [store, open, current]);

  useLayoutEffect(() => {
    const target = explicitTarget.current;
    if (open === 'questions' && target) {
      explicitTarget.current = null;
      const heading = headings.current.get(target);
      if (heading && scrolling.current) {
        scrolling.current.scrollTop += heading.getBoundingClientRect().top - scrolling.current.getBoundingClientRect().top;
        heading.focus({ preventScroll: true });
      }
    }
  }, [items, open, openRequest]);

  useLayoutEffect(() => {
    if (open === 'questions' && focusAfterRemoval.current) {
      focusAfterRemoval.current = false;
      headings.current.values().next().value?.focus({ preventScroll: true });
    }
  }, [items, open]);

  useLayoutEffect(() => {
    if (open === 'questions') {
      if (surface.current?.contains(document.activeElement)) { return; }
      const first = headings.current.entries().next().value;
      if (first) { first[1].focus({ preventScroll: true }); }
    }
  }, [open]);

  const navigate = (id: string) => {
    const heading = headings.current.get(id);
    if (heading && scrolling.current) {
      scrolling.current.scrollTop += heading.getBoundingClientRect().top - scrolling.current.getBoundingClientRect().top;
      heading.focus({ preventScroll: true });
      setCurrent(id);
    }
  };
  return (
    <ExpansionContext value={{ open, setOpen }}>
      <div id="questionAnchor" className="question-anchor relative flex flex-none flex-col">
        {items.length > 0 && <button
          ref={notification}
          type="button"
          aria-label={`Open questions (${items.length})`}
          aria-expanded={open === 'questions'}
          aria-controls={open === 'questions' ? detailsId : undefined}
          className="question-notification mx-3 my-1 rounded-md border border-dashed border-border bg-muted px-3 py-2 text-left text-muted-foreground hover:bg-hover focus-visible:outline-1 focus-visible:outline-ring"
          onPointerDown={rememberFocus}
          onClick={(event) => {
            if (open === 'questions') { close(); }
            else { if (event.detail === 0) { rememberFocus(); } setCurrent(items[0]?.question.interactionId ?? null); setOpen('questions'); }
          }}
        >{items.length} {items.length === 1 ? 'question' : 'questions'} awaiting your response</button>}
        {children}
        {open === 'questions' && items.length > 0 && <section
          ref={surface}
          id={detailsId}
          aria-label="Questions"
          className="question-surface absolute right-3 bottom-8 left-3 z-100 flex max-h-[min(36rem,60vh)] flex-col rounded-md border border-popover-border bg-popover text-popover-foreground shadow-popover"
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          }}
        >
          <div className="flex flex-none items-center justify-between gap-2 border-b border-border p-2">
            <nav aria-label="Question navigation" className="flex flex-wrap gap-1">
              {items.map(({ question }, index) => <button
                key={question.interactionId}
                type="button"
                aria-label={`Question ${index + 1}`}
                aria-current={current === question.interactionId ? 'true' : undefined}
                className={`${buttonStyle} ${current === question.interactionId ? 'outline-1 outline-ring' : ''}`}
                onClick={() => navigate(question.interactionId)}
              >({index + 1})</button>)}
            </nav>
            <button type="button" className={buttonStyle} aria-label="Collapse questions" onClick={close}>Collapse</button>
          </div>
          <div ref={scrolling} aria-label="Pending questions" className="min-h-0 overflow-y-auto overscroll-contain p-3" onScroll={() => {
            const top = scrolling.current?.getBoundingClientRect().top ?? 0;
            const visible = [...headings.current].find(([, heading]) => heading.getBoundingClientRect().bottom > top);
            if (visible) { setCurrent(visible[0]); }
          }}>
            {items.map((item) => <QuestionForm key={item.question.interactionId} item={item} headingRef={(heading) => {
              if (heading) { headings.current.set(item.question.interactionId, heading); }
              else { headings.current.delete(item.question.interactionId); }
            }} />)}
          </div>
        </section>}
      </div>
    </ExpansionContext>
  );
}

function QuestionForm({ item, headingRef }: { item: Item; headingRef: (heading: HTMLHeadingElement | null) => void }) {
  const { question, submitting, errors } = item;
  const dispatch = useDispatch();
  const id = useId();
  return <form data-question-id={question.interactionId} aria-labelledby={id} noValidate className="mb-4 space-y-3 border-b border-border pb-4 last:mb-0 last:border-0" onSubmit={(event) => {
    event.preventDefault();
    dispatch({ type: 'questionSubmitted', interactionId: question.interactionId });
  }}>
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{question.agentName}</p>
        <h3 ref={headingRef} id={id} tabIndex={-1} className="font-semibold whitespace-pre-wrap wrap-anywhere focus:outline-1 focus:outline-ring">{question.title ?? 'Question'}</h3>
      </div>
      <button type="button" disabled={submitting} className={buttonStyle} aria-label="Dismiss question" onClick={() => dispatch({ type: 'questionDismissed', interactionId: question.interactionId, action: 'cancel' })}>Dismiss</button>
    </div>
    <p className="whitespace-pre-wrap wrap-anywhere">{question.message}</p>
    {question.description !== null && <p className="whitespace-pre-wrap wrap-anywhere">{question.description}</p>}
    <p className="text-xs text-muted-foreground">Answers go to {question.agentName}. Do not include passwords, tokens, or other secrets.</p>
    {Object.hasOwn(errors, '') && <p role="alert">{errors['']}</p>}
    <fieldset disabled={submitting} className="min-w-0 space-y-3">
      {question.fields.map((field) => <QuestionField key={field.name} field={field} item={item} />)}
    </fieldset>
    <div className="flex gap-2">
      <button type="submit" disabled={submitting} className={buttonStyle}>Submit</button>
      <button type="button" disabled={submitting} className={buttonStyle} onClick={() => dispatch({ type: 'questionDismissed', interactionId: question.interactionId, action: 'decline' })}>Refuse</button>
    </div>
  </form>;
}

function QuestionField({ field, item }: { field: Field; item: Item }) {
  const id = useId();
  const dispatch = useDispatch();
  const interactionId = item.question.interactionId;
  const value = Object.hasOwn(item.draft, field.name) ? item.draft[field.name] : undefined;
  const error = Object.hasOwn(item.errors, field.name) ? item.errors[field.name] : undefined;
  const title = field.title ?? field.name;
  const edit = (value: NonNullable<Item['draft'][string]>) => dispatch({ type: 'questionFieldEdited', interactionId, name: field.name, value });
  const clear = () => dispatch({ type: 'questionFieldCleared', interactionId, name: field.name });
  const common = { id, 'aria-invalid': error ? true as const : undefined, 'aria-describedby': `${id}-help${error ? ` ${id}-error` : ''}`, required: field.required, className: controlStyle };
  return <div className="space-y-1">
    <div className="flex items-center justify-between gap-2">
      <label id={`${id}-label`} htmlFor={field.kind === 'multiple' ? undefined : id}>{title}{field.required ? ' *' : ''}</label>
      {!field.required && value !== undefined && <button type="button" className={buttonStyle} aria-label={`Clear ${title}`} onClick={clear}>Clear</button>}
    </div>
    <div id={`${id}-help`} className="space-y-1 text-xs text-muted-foreground">
      {field.description !== null && <p className="whitespace-pre-wrap wrap-anywhere">{field.description}</p>}
      {(field.minimum !== null || field.maximum !== null) && <p>Minimum: {field.minimum ?? 'none'}; maximum: {field.maximum ?? 'none'}</p>}
      {(field.minItems !== null || field.maxItems !== null) && <p>Selections: minimum {field.minItems ?? 0}; maximum {field.maxItems ?? 'none'}</p>}
      {(field.minLength !== null || field.maxLength !== null) && <p>Length: minimum {field.minLength ?? 0}; maximum {field.maxLength ?? 'none'}</p>}
      {field.pattern !== null && <p className="whitespace-pre-wrap wrap-anywhere">Pattern: {field.pattern}</p>}
      {field.format !== null && <p className="whitespace-pre-wrap wrap-anywhere">Format: {field.format}</p>}
    </div>
    {field.kind === 'multiple' ? <fieldset aria-labelledby={`${id}-label`} aria-describedby={common['aria-describedby']} aria-invalid={common['aria-invalid']} className="space-y-1">
      {field.choices?.map((choice) => <div key={choice.value}>
        <label className="flex items-center gap-2"><input type="checkbox" checked={Array.isArray(value) && value.includes(choice.value)} onChange={(event) => {
          const selected = typeof value === 'object' ? value : [];
          edit(event.target.checked ? [...selected, choice.value] : selected.filter((entry) => entry !== choice.value));
        }} />{choice.title}</label>
        {choice.description !== null && <p className="ml-5 text-xs whitespace-pre-wrap wrap-anywhere">{choice.description}</p>}
      </div>)}
    </fieldset> : field.kind === 'boolean' ? <select {...common} value={typeof value === 'boolean' ? String(value) : ''} onChange={(event) => {
      if (event.target.value === '') { clear(); } else { edit(event.target.value === 'true'); }
    }}><option value="">Not answered</option><option value="true">True</option><option value="false">False</option></select>
      : field.choices !== null ? <>
        <select {...common} value={typeof value === 'string' ? `value:${value}` : ''} onChange={(event) => {
          if (event.target.value === '') { clear(); } else { edit(event.target.value.slice(6)); }
        }}>
          <option value="">Not answered</option>
          {field.choices.map((choice) => <option key={choice.value} value={`value:${choice.value}`}>{choice.title}</option>)}
        </select>
        {field.choices.map((choice) => choice.description === null ? null : <p key={choice.value} className="text-xs whitespace-pre-wrap wrap-anywhere">{choice.title}: <span>{choice.description}</span></p>)}
      </> : <input {...common}
        type="text"
        inputMode={field.kind === 'integer' || field.kind === 'number' ? 'decimal' : undefined}
        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
        minLength={field.minLength ?? undefined} maxLength={field.maxLength ?? undefined} pattern={field.pattern ?? undefined}
        onChange={(event) => edit(event.target.value)}
      />}
    {error && <p id={`${id}-error`} role="alert" className="text-error">{error}</p>}
  </div>;
}
