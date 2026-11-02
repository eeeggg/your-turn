import { createContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { toWords } from 'to-words/en-US';
import { questionAnswers, type QuestionsState } from '@/webview/state/Questions';
import { useDispatch, useSelector, useStore } from '@/webview/views/StoreContext';
import { Chevron } from '@/webview/views/elements/Chevron';

type Expansion = 'questions' | 'usage' | null;
export const ExpansionContext = createContext<{ open: Expansion; setOpen: (open: Expansion) => void } | null>(null);
type Item = QuestionsState['items'][number];
type Field = Item['question']['fields'][number];
const controlStyle = 'w-full rounded-sm border-2 border-control-border bg-input px-2.5 py-2 text-input-foreground focus:border-ring focus:outline-1 focus:outline-ring';
const iconButtonStyle = 'cursor-pointer rounded-sm px-2 py-1 hover:bg-secondary-hover focus-visible:outline-1 focus-visible:outline-ring';
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
      setCurrent(id);
    }
  };
  return (
    <ExpansionContext value={{ open, setOpen }}>
      <div id="questionAnchor" className="question-anchor relative flex flex-none flex-col">
        {items.length > 0 && <button
          ref={notification}
          type="button"
          aria-expanded={open === 'questions'}
          aria-controls={open === 'questions' ? detailsId : undefined}
          className="question-notification mx-3 mt-2 mb-2 flex cursor-pointer items-center gap-3 rounded-md border border-control-border border-l-3 border-l-link bg-muted px-3 py-2 text-left text-foreground hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
          onPointerDown={rememberFocus}
          onClick={(event) => {
            if (open === 'questions') { close(); }
            else { if (event.detail === 0) { rememberFocus(); } setCurrent(items[0]?.question.interactionId ?? null); setOpen('questions'); }
          }}
        ><span className="min-w-0 flex-1">{items.length === 1 ? 'An elicitation is' : `${toWords(items.length, { casing: 'sentence', hyphenate: true })} elicitations are`} awaiting your response</span><Chevron direction={open === 'questions' ? 'down' : 'up'} /></button>}
        {children}
        {open === 'questions' && items.length > 0 && <section
          ref={surface}
          id={detailsId}
          aria-label="Elicitations"
          className="question-surface absolute right-3 bottom-8 left-3 z-100 flex max-h-[min(36rem,60vh)] flex-col rounded-md border border-control-border bg-popover text-popover-foreground shadow-popover"
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          }}
        >
          <div className="flex flex-none items-center justify-between gap-2 border-b border-border p-2">
            {items.length > 1 ? <nav aria-label="Elicitation navigation" className="flex items-center gap-2">
              <button type="button" className={iconButtonStyle} aria-label="Previous elicitation" title="Previous elicitation" onClick={() => {
                const index = Math.max(0, items.findIndex((item) => item.question.interactionId === current));
                const target = items[(index - 1 + items.length) % items.length];
                if (target) { navigate(target.question.interactionId); }
              }}><Chevron direction="left" /></button>
              <button type="button" className={iconButtonStyle} aria-label="Next elicitation" title="Next elicitation" onClick={() => {
                const index = Math.max(0, items.findIndex((item) => item.question.interactionId === current));
                const target = items[(index + 1) % items.length];
                if (target) { navigate(target.question.interactionId); }
              }}><Chevron direction="right" /></button>
            </nav> : <span className="text-xs text-muted-foreground">Elicitation</span>}
            <button type="button" className={iconButtonStyle} aria-label="Collapse elicitations" title="Collapse elicitations" onClick={close}><Chevron direction="down" /></button>
          </div>
          <div ref={scrolling} aria-label="Pending elicitations" className="min-h-0 overflow-y-auto overscroll-contain p-3" onScroll={() => {
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
  const keepEditing = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const valid = Object.keys(questionAnswers(item).errors).length === 0;
  useLayoutEffect(() => {
    if (item.confirmingEmpty) { keepEditing.current?.focus(); confirmation.current?.scrollIntoView({ block: 'nearest' }); }
    else if (wasConfirming.current && !submitting) { submit.current?.focus(); }
    wasConfirming.current = item.confirmingEmpty;
  }, [item.confirmingEmpty, submitting]);
  return <form data-question-id={question.interactionId} aria-labelledby={id} noValidate className="mb-4 space-y-3 border-b border-border pb-4 last:mb-0 last:border-0" onSubmit={(event) => {
    event.preventDefault();
    dispatch({ type: 'questionSubmitted', interactionId: question.interactionId });
  }}>
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{question.agentName}</p>
        <h3 ref={headingRef} id={id} tabIndex={-1} className="font-semibold whitespace-pre-wrap wrap-anywhere outline-none">{question.title ?? 'Elicitation'}</h3>
      </div>
    </div>
    <p className="whitespace-pre-wrap wrap-anywhere">{question.message}</p>
    {question.description !== null && <p className="whitespace-pre-wrap wrap-anywhere">{question.description}</p>}
    <p className="text-xs text-muted-foreground">Answers go to {question.agentName}. Do not include passwords, tokens, or other secrets.</p>
    {Object.hasOwn(errors, '') && <p role="alert">{errors['']}</p>}
    <fieldset disabled={submitting} className="min-w-0 space-y-3">
      {question.fields.map((field) => <QuestionField key={field.name} field={field} item={item} />)}
    </fieldset>
    {item.confirmingEmpty ? <div ref={confirmation} className="space-y-2 rounded-md border border-control-border bg-muted p-3" role="group" aria-labelledby={`${id}-confirmation`}>
      <p id={`${id}-confirmation`} className="font-semibold">Submit without answers?</p>
      <p>No answers have been provided. Submitting will accept this elicitation without supplying any answers.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={submitting} className={buttonStyle} onClick={() => dispatch({ type: 'questionEmptyConfirmed', interactionId: question.interactionId })}>Submit without answers</button>
        <button ref={keepEditing} type="button" className={buttonStyle} onClick={() => dispatch({ type: 'questionEditingContinued', interactionId: question.interactionId })}>Keep editing</button>
      </div>
    </div> : <ResponseActions submitting={submitting} valid={valid} submitRef={submit} respond={(action) => dispatch({ type: 'questionDismissed', interactionId: question.interactionId, action })} />}
  </form>;
}

function ResponseActions({ submitting, valid, submitRef, respond }: {
  submitting: boolean; valid: boolean; submitRef: React.RefObject<HTMLButtonElement | null>;
  respond: (action: 'decline' | 'cancel') => void;
}) {
  return <div className="flex flex-wrap gap-2 border-t border-border pt-3">
    {(['Submit', 'Decline', 'Cancel'] as const).map((label) => <button key={label}
      ref={label === 'Submit' ? submitRef : undefined} type={label === 'Submit' ? 'submit' : 'button'}
      disabled={submitting || (label === 'Submit' && !valid)}
      className={label === 'Submit' ? 'cursor-pointer rounded-sm bg-primary px-2 py-1 text-primary-foreground hover:bg-primary-hover focus-visible:outline-1 focus-visible:outline-ring disabled:opacity-40' : buttonStyle}
      onClick={label === 'Submit' ? undefined : () => respond(label === 'Decline' ? 'decline' : 'cancel')}>{label}</button>)}
  </div>;
}

function QuestionField({ field, item }: { field: Field; item: Item }) {
  const id = useId();
  const dispatch = useDispatch();
  const interactionId = item.question.interactionId;
  const value = Object.hasOwn(item.draft, field.name) ? item.draft[field.name] : undefined;
  const validation = questionAnswers(item).errors;
  const error = Object.hasOwn(item.errors, field.name) ? item.errors[field.name] : validation[field.name];
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
