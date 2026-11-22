import CircleCheck from 'lucide-react/icons/circle-check';
import CircleDot from 'lucide-react/icons/circle-dot';
import CircleExclamationPoint from 'lucide-react/icons/circle-exclamation-point';
import CircleQuestionMark from 'lucide-react/icons/circle-question-mark';
import X from 'lucide-react/icons/x';
import type { LucideIcon } from 'lucide-react';
import { useId, useLayoutEffect, useRef } from 'react';
import type { SessionTabsSnapshot } from '@/shared/WebviewMessages';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';

type TabStatus = SessionTabsSnapshot['tabs'][number]['status'];

interface StatusMarker {
  icon: LucideIcon;
  label: string;
  style: string;
}

const reviewMarkers = [
  { key: 'modified', glyph: 'M', label: 'Modified files', color: 'text-review-modified' },
  { key: 'created', glyph: 'U', label: 'Created files', color: 'text-review-created' },
  { key: 'deleted', glyph: 'D', label: 'Deleted files', color: 'text-review-deleted' },
] as const;

const statusMarkers: Record<TabStatus, StatusMarker | null> = {
  quiet: null,
  working: { icon: CircleDot, label: 'Actively working', style: 'activity-dot text-success' },
  needsInput: { icon: CircleQuestionMark, label: 'Needs your input', style: 'text-warning' },
  failed: { icon: CircleExclamationPoint, label: 'Interrupted or failed', style: 'text-failure' },
  completed: { icon: CircleCheck, label: 'Finished while unselected', style: 'text-muted-foreground' },
};

/** Manual-activation tabs: arrow keys move focus; Enter or Space requests an open. */
export function SessionTabs() {
  const navigation = useSelector((state) => state.sessionTabs);
  const announcement = useSelector((state) => state.tabAnnouncement);
  const dispatch = useDispatch();
  const strip = useRef<HTMLDivElement>(null);
  const focusedTab = useRef<string | null>(null);
  const descriptionPrefix = useId();
  const selected = navigation.selectedTabId ?? navigation.tabs[0]?.tabId;

  useLayoutEffect(() => {
    if (!focusedTab.current || navigation.tabs.some((tab) => tab.tabId === focusedTab.current)) { return; }
    const buttons = strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const next = navigation.tabs.findIndex((tab) => tab.tabId === selected);
    buttons?.[next]?.focus();
    focusedTab.current = selected ?? null;
  }, [navigation, selected]);

  return (
    <>
    <div id="sessionTabs" ref={strip} role="tablist" aria-label="Sessions" hidden={navigation.tabs.length === 0}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) { focusedTab.current = null; }
      }}
      className="session-tabs flex-none border-b border-border bg-muted">
      <div role="presentation" className="flex flex-wrap">
        {navigation.tabs.map((tab, index) => {
          const label = tab.title || tab.agentName;
          const current = tab.tabId === navigation.selectedTabId;
          const descriptionId = `${descriptionPrefix}-${tab.tabId}`;
          const markers = reviewMarkers.filter(({ key }) => tab.review[key]);
          const status = tab.status === 'completed' && current ? null : statusMarkers[tab.status];
          const description = [
            ...(status ? [status.label] : []),
            ...markers.map(({ label }) => label),
          ].map((part) => `${part}.`).join(' ');
          return <div key={tab.tabId} role="presentation"
            className={`flex max-w-[min(100%,15rem)] flex-none items-center border-t-2 border-r border-r-border ${current
              ? 'session-tab-selected border-t-tab-active-border bg-tab-active text-tab-active-foreground'
              : 'border-t-transparent bg-tab-inactive text-tab-inactive-foreground'}`}>
            <button type="button" role="tab" aria-label={label} aria-selected={current} tabIndex={tab.tabId === selected ? 0 : -1}
              aria-describedby={description ? descriptionId : undefined}
              onFocus={() => { focusedTab.current = tab.tabId; }}
              title={[label, tab.agentName, tab.cwd, ...tab.additionalDirectories].join('\n')}
              className={`flex min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-sm focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring ${current ? '' : 'hover:bg-hover'}`}
              onClick={() => dispatch({ type: 'sessionTabSelected', tabId: tab.tabId })}
              onKeyDown={(event) => {
                let next: number;
                switch (event.key) {
                  case 'ArrowLeft': next = (index + navigation.tabs.length - 1) % navigation.tabs.length; break;
                  case 'ArrowRight': next = (index + 1) % navigation.tabs.length; break;
                  case 'Home': next = 0; break;
                  case 'End': next = navigation.tabs.length - 1; break;
                  case 'Delete':
                    event.preventDefault();
                    dispatch({ type: 'sessionTabClosed', tabId: tab.tabId });
                    return;
                  default: return;
                }
                event.preventDefault();
                strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
              }}>
              {status && (
                <span aria-hidden="true" aria-label={status.label} className={`inline-flex size-3.5 flex-none items-center justify-center ${status.style}`}>
                  <status.icon size={14} />
                </span>
              )}
              {markers.length > 0 && <span aria-hidden="true" className="session-tab-markers flex flex-none gap-0.5">
                {markers.map(({ key, glyph, color }) => <span key={key} className={color}>{glyph}</span>)}
              </span>}
              <span className="truncate">{label}</span>
            </button>
            {description && <span id={descriptionId} hidden>{description}</span>}
            <button type="button" aria-label={`Close ${label}`} title={`Close ${label}`}
              onFocus={() => { focusedTab.current = tab.tabId; }}
              className="mr-1 flex size-6 flex-none cursor-pointer items-center justify-center rounded-sm text-base hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => dispatch({ type: 'sessionTabClosed', tabId: tab.tabId })}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>;
        })}
      </div>
    </div>
    <span id="sessionTabStatus" className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement && <span key={announcement.revision}>{announcement.text}</span>}
    </span>
    </>
  );
}
