import { useLayoutEffect, useRef } from 'react';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';

/** Manual-activation tabs: arrow keys move focus; Enter or Space requests an open. */
export function SessionTabs() {
  const navigation = useSelector((state) => state.sessionTabs);
  const dispatch = useDispatch();
  const strip = useRef<HTMLDivElement>(null);
  const focusedTab = useRef<string | null>(null);
  const selected = navigation.selectedTabId ?? navigation.tabs[0]?.tabId;

  useLayoutEffect(() => {
    if (!focusedTab.current || navigation.tabs.some((tab) => tab.tabId === focusedTab.current)) { return; }
    const buttons = strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const next = navigation.tabs.findIndex((tab) => tab.tabId === selected);
    buttons?.[next]?.focus();
    focusedTab.current = selected ?? null;
  }, [navigation, selected]);

  return (
    <div id="sessionTabs" ref={strip} role="tablist" aria-label="Sessions" hidden={navigation.tabs.length === 0}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) { focusedTab.current = null; }
      }}
      className="session-tabs flex-none border-b border-border bg-muted">
      <div role="presentation" className="flex flex-wrap">
        {navigation.tabs.map((tab, index) => {
          const label = tab.title || tab.agentName;
          const current = tab.tabId === navigation.selectedTabId;
          return <div key={tab.tabId} role="presentation"
            className={`group flex max-w-[min(100%,15rem)] flex-none items-center border-r border-border ${current ? 'bg-background text-foreground' : 'text-muted-foreground'}`}>
            <button type="button" role="tab" aria-label={label} aria-selected={current} tabIndex={tab.tabId === selected ? 0 : -1}
              onFocus={() => { focusedTab.current = tab.tabId; }}
              title={[label, tab.agentName, tab.cwd, ...tab.additionalDirectories].join('\n')}
              className="flex min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-hover focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
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
              {tab.running && <span aria-label="Actively working" className="activity-dot size-2 flex-none rounded-full bg-success" />}
              <span className="truncate">{label}</span>
            </button>
            <button type="button" aria-label={`Close ${label}`} title={`Close ${label}`}
              onFocus={() => { focusedTab.current = tab.tabId; }}
              className="mr-1 flex size-6 flex-none cursor-pointer items-center justify-center rounded-sm text-base hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => dispatch({ type: 'sessionTabClosed', tabId: tab.tabId })}>×</button>
          </div>;
        })}
      </div>
    </div>
  );
}
