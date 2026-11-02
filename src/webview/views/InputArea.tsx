import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import type { SlashCommand } from '@/shared/WebviewMessages';
import { canPrompt } from '@/webview/state/ActiveSession';
import { InputToolbar } from '@/webview/views/InputToolbar';
import { Usage } from '@/webview/views/Usage';
import { highlightedIndex, historyMoves, matchingCommands, placeholder } from '@/webview/state/PromptBox';
import { useCurrentState, useDispatch, useSelector } from '@/webview/views/StoreContext';

const MIN_HEIGHT = 90;
const MAX_HEIGHT = 400;

/** Everything below the transcript: the slash command popup, pickers, prompt box and session usage. */
export function InputArea() {
  const session = useSelector((state) => state.activeSession);
  const box = useSelector((state) => state.promptBox);
  const usage = useSelector((state) => state.transcript.usage);
  const dispatch = useDispatch();
  const currentState = useCurrentState();
  const areaRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  const usable = canPrompt(session);
  const matches = matchingCommands(box, session);
  const highlighted = highlightedIndex(box, matches);

  const { recall } = box;
  useLayoutEffect(() => {
    const input = promptRef.current;
    if (input && recall) {
      const at = recall.caret === 'start' ? 0 : input.value.length;
      input.setSelectionRange(at, at);
    }
  }, [recall]);

  const choose = (command: SlashCommand) => {
    dispatch({ type: 'slashCommandChosen', name: command.name });
    promptRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const enter = event.key === 'Enter' && !event.shiftKey;
    const command = matches[highlighted];
    if (command) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        dispatch({ type: 'slashHighlightMoved', by: event.key === 'ArrowDown' ? 1 : -1 });
      } else if (event.key === 'Tab' || enter) {
        event.preventDefault();
        choose(command);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        dispatch({ type: 'slashPopupDismissed' });
      }
    } else if (enter) {
      event.preventDefault();
      dispatch({ type: 'promptSent' });
    } else if (atHistoryEdge(event)) {
      const to = event.key === 'ArrowUp' ? 'older' : 'newer';
      const { promptBox, activeSession, transcript } = currentState();
      if (historyMoves(promptBox, to, activeSession, transcript)) {
        event.preventDefault();
        dispatch({ type: 'historyMoved', to });
      }
    }
  };

  const inactive = usable ? '' : 'pointer-events-none opacity-40';

  return (
    <div
      className={`input-area ${usable ? '' : 'disabled '}relative flex min-h-fit flex-none flex-col border-t border-border bg-background`}
      id="inputArea"
      ref={areaRef}
      style={height === null ? undefined : { height }}
    >
      <div
        className={`slash-popup ${matches.length > 0 ? 'open block' : 'hidden'} absolute right-3 bottom-full left-3 z-200 mb-1 max-h-50 overflow-y-auto rounded-md border border-suggest-border bg-suggest shadow-popup`}
        id="slashPopup"
      >
        <div className="slash-popup-header px-2.5 pt-1.5 pb-1 text-xs font-semibold tracking-[0.5px] text-muted-foreground uppercase">
          Commands
        </div>
        {matches.map((command, index) => (
          <SlashCommandItem
            key={command.name}
            command={command}
            active={index === highlighted}
            onHover={() => dispatch({ type: 'slashCommandHighlighted', index })}
            onChoose={() => choose(command)}
          />
        ))}
      </div>
      <ResizeHandle areaRef={areaRef} onResize={setHeight} />
      <div className={`input-toolbar flex flex-none flex-wrap items-center gap-1 px-3 pt-1 ${inactive}`} id="inputToolbar">
        <InputToolbar />
      </div>
      <div className={`input-editor-wrap flex min-h-0 flex-1 px-3 pb-2 ${inactive}`}>
        <textarea
          className="min-h-9.5 min-w-0 flex-1 resize-none rounded-md border border-control-border bg-input px-2.5 py-2 leading-[1.4] text-input-foreground outline-none placeholder:text-input-placeholder focus:border-ring"
          id="promptInput"
          ref={promptRef}
          rows={2}
          placeholder={placeholder(session)}
          value={box.text}
          disabled={!usable}
          onChange={(event) => dispatch({ type: 'promptEdited', text: event.target.value })}
          onKeyDown={onKeyDown}
        />
      </div>
      {usage && <Usage usage={usage} />}
      <span className="sr-only" id="promptHistoryStatus" role="status" aria-live="polite" aria-atomic="true">
        {box.announcement}
      </span>
    </div>
  );
}

/**
 * Up with the caret at the start of the text, or Down with it at the end, unmodified and with nothing selected. The
 * textarea itself brings the caret there from the first or last visual line, so every other press stays its own.
 */
function atHistoryEdge(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  const { key, shiftKey, altKey, ctrlKey, metaKey, currentTarget } = event;
  const { selectionStart, selectionEnd, value } = currentTarget;
  if ((key !== 'ArrowUp' && key !== 'ArrowDown') || shiftKey || altKey || ctrlKey || metaKey || selectionStart !== selectionEnd) {
    return false;
  }
  return key === 'ArrowUp' ? selectionStart === 0 : selectionEnd === value.length;
}

function SlashCommandItem({
  command,
  active,
  onHover,
  onChoose,
}: {
  command: SlashCommand;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  const itemRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (active) {
      itemRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [active]);

  return (
    <div
      className={`slash-popup-item ${active ? 'active bg-hover' : ''} flex cursor-pointer items-baseline gap-2 px-2.5 py-1.5 hover:bg-hover`}
      ref={itemRef}
      onMouseEnter={onHover}
      onClick={onChoose}
    >
      <span className="cmd-name font-mono font-semibold whitespace-nowrap text-link">/{command.name}</span>
      {command.hint && <span className="cmd-hint font-mono whitespace-nowrap text-muted-foreground italic">{command.hint}</span>}
      <span className="cmd-desc flex-1 truncate text-md text-muted-foreground">{command.description}</span>
    </div>
  );
}

/** Dragging it up makes the input area taller. */
function ResizeHandle({
  areaRef,
  onResize,
}: {
  areaRef: RefObject<HTMLDivElement | null>;
  onResize: (height: number) => void;
}) {
  const onMouseDown = (event: MouseEvent) => {
    const area = areaRef.current;
    if (!area) {
      return;
    }
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = area.offsetHeight;
    const onMove = (move: globalThis.MouseEvent) =>
      onResize(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + startY - move.clientY)));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className="input-resize-handle flex h-1 flex-none cursor-ns-resize items-center justify-center after:h-0.5 after:w-8 after:rounded-[1px] after:bg-border after:transition-colors hover:after:bg-ring"
      id="resizeHandle"
      onMouseDown={onMouseDown}
    />
  );
}
