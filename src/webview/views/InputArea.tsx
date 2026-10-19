import type { AvailableCommand } from '@agentclientprotocol/sdk';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { canPrompt } from '@/webview/state/ActiveSession';
import { InputToolbar } from '@/webview/views/InputToolbar';
import { highlightedIndex, matchingCommands, placeholder } from '@/webview/state/PromptBox';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';

const MIN_HEIGHT = 90;
const MAX_HEIGHT = 400;

const sendButton =
  'send bg-primary text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50';
const stopButton = 'stop border border-destructive-border bg-destructive text-destructive-foreground hover:opacity-90';

/** Everything below the transcript: the slash command popup, the pickers, the prompt box, and Send/Stop. */
export function InputArea() {
  const session = useSelector((state) => state.activeSession);
  const box = useSelector((state) => state.promptBox);
  const dispatch = useDispatch();
  const areaRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  const usable = canPrompt(session);
  const turnRunning = session?.turnRunning ?? false;
  const matches = matchingCommands(box, session);
  const highlighted = highlightedIndex(box, matches);

  const choose = (command: AvailableCommand) => {
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
    }
  };

  const inactive = usable ? '' : 'pointer-events-none opacity-40';

  return (
    <div
      className={`input-area ${usable ? '' : 'disabled '}relative flex flex-col border-t border-border bg-background`}
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
      <div className={`input-editor-wrap flex min-h-0 flex-1 px-3 ${inactive}`}>
        <textarea
          className="min-h-9.5 flex-1 resize-none rounded-md border border-input-border bg-input px-2.5 py-2 leading-[1.4] text-input-foreground outline-none placeholder:text-input-placeholder focus:border-ring"
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
      <div className={`input-send-row flex flex-none items-center justify-end gap-1.5 px-3 pt-1 pb-2 ${inactive}`}>
        <button
          className={`send-stop-btn ${turnRunning ? stopButton : sendButton} inline-flex h-6.5 min-w-15 cursor-pointer items-center justify-center gap-1 rounded-xl px-3.5 py-1 font-medium whitespace-nowrap transition-colors`}
          id="sendStopBtn"
          disabled={!usable}
          onClick={() => dispatch({ type: turnRunning ? 'turnCancelled' : 'promptSent' })}
        >
          {turnRunning ? '■ Stop' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function SlashCommandItem({
  command,
  active,
  onHover,
  onChoose,
}: {
  command: AvailableCommand;
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
      {command.input?.hint && (
        <span className="cmd-hint font-mono whitespace-nowrap text-muted-foreground italic">{command.input.hint}</span>
      )}
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
