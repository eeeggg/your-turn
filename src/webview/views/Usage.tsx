import { use, useId, useRef, useState } from 'react';
import { code } from 'currency-codes';
import type { SessionUsage } from '@/shared/WebviewMessages';
import { ExpansionContext } from '@/webview/views/Questions';
import { Chevron } from '@/webview/views/elements/Chevron';

const tokenFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 21 });
const costFormat = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

export function Usage({ usage }: { usage: SessionUsage }) {
  const [localOpen, setLocalOpen] = useState(false);
  const expansion = use(ExpansionContext);
  const open = expansion ? expansion.open === 'usage' : localOpen;
  const setOpen = (value: boolean) => {
    if (expansion) { if (value || expansion.open === 'usage') { expansion.setOpen(value ? 'usage' : null); } }
    else { setLocalOpen(value); }
  };
  const [pointerFocus, setPointerFocus] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const detailsId = useId();
  const readoutId = useId();
  const { used, size, cost } = usage;
  const usedText = tokenFormat.format(used);
  const sizeText = tokenFormat.format(size);
  const costText = cost === null ? null : formatSessionCost(cost);
  // Browsers can keep :focus-visible after a pointer click on an already-focused control.
  const focusStyle = pointerFocus ? 'outline-none' : 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';

  const close = () => {
    setOpen(false);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected && !target.matches(':disabled')) {
      target.focus({ preventScroll: true });
      if (document.activeElement === target) { return; }
    }
    buttonRef.current?.focus({ preventScroll: true });
  };

  return (
    <div
      className="usage-footer relative mx-3 flex-none pb-2 text-xs"
      onPointerDownCapture={() => setPointerFocus(true)}
      onKeyDownCapture={() => setPointerFocus(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
          setPointerFocus(false);
          returnFocusRef.current = null;
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label="Session usage"
        aria-describedby={readoutId}
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        title="Agent-reported session usage"
        className={`usage-readout flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-sm px-1 py-0.5 text-left text-muted-foreground tabular-nums hover:bg-toolbar-hover hover:text-foreground ${focusStyle}`}
        onPointerDown={() => {
          // Pointer focus moves to the button before click, so capture its predecessor here.
          if (!open) {
            returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }
        }}
        onClick={(event) => {
          if (open) {
            close();
          } else {
            if (event.detail === 0) {
              returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            }
            setOpen(true);
          }
        }}
      >
        <span id={readoutId} className="min-w-0 flex-1 wrap-anywhere">{`${usedText} / ${sizeText} tokens${costText === null ? '' : ` · ${costText.summary}`}`}</span>
        <Chevron direction={open ? 'down' : 'up'} size={12} className="mt-0.5" />
      </button>
      {open && (
        <section
          id={detailsId}
          aria-label="Session usage details"
          tabIndex={0}
          className={`usage-details absolute right-0 bottom-full left-0 z-100 mb-1 max-h-[min(20rem,60vh)] overflow-y-auto rounded-md border border-popover-border bg-popover p-3 text-popover-foreground shadow-popover ${focusStyle}`}
        >
          <h3 className="mb-2 text-control font-semibold">Session usage</h3>
          <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="text-muted-foreground">Tokens in context</dt>
            <dd className="text-right font-mono tabular-nums wrap-anywhere">{usedText}</dd>
            <dt className="text-muted-foreground">Context window limit</dt>
            <dd className="text-right font-mono tabular-nums wrap-anywhere">{sizeText}</dd>
            {costText !== null && <>
              <dt className="text-muted-foreground">Session cost</dt>
              <dd className="text-right font-mono tabular-nums wrap-anywhere">{costText.details}</dd>
            </>}
          </dl>
          <p className="mt-3 border-t border-border pt-2 leading-relaxed text-muted-foreground">
            {costText === null ? 'Reported by the agent.' : 'Reported by the agent. Cost is cumulative for this session.'}
          </p>
        </section>
      )}
    </div>
  );
}

function formatSessionCost({ amount, currency }: NonNullable<SessionUsage['cost']>): { summary: string; details: string } {
  // The lookup is case-insensitive; require the reported spelling to match the ISO code.
  if (code(currency)?.code !== currency) {
    const text = `${new Intl.NumberFormat('en-US', costFormat).format(amount)} ${currency}`;
    return { summary: text, details: text };
  }
  const parts = new Intl.NumberFormat('en-US', { ...costFormat, style: 'currency', currency, currencyDisplay: 'symbol' }).formatToParts(amount);
  const summary = parts.map((part) => part.value).join('');
  const includesCode = parts.some((part) => part.type === 'currency' && part.value === currency);
  return { summary, details: includesCode ? summary : `${summary} ${currency}` };
}
