import type { AvailableCommand } from '@agentclientprotocol/sdk';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { canPrompt } from '@/webview/state/ActiveSession';
import { InputToolbar } from '@/webview/views/InputToolbar';
import { highlightedIndex, matchingCommands, placeholder } from '@/webview/state/PromptBox';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';

const MIN_HEIGHT = 90;
const MAX_HEIGHT = 400;

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

  return (
    <div
      className={usable ? 'input-area' : 'input-area disabled'}
      id="inputArea"
      ref={areaRef}
      style={height === null ? undefined : { height }}
    >
      <div className={matches.length > 0 ? 'slash-popup open' : 'slash-popup'} id="slashPopup">
        <div className="slash-popup-header">Commands</div>
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
      <div className="input-toolbar" id="inputToolbar">
        <InputToolbar />
      </div>
      <div className="input-editor-wrap">
        <textarea
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
      <div className="input-send-row">
        <button
          className={turnRunning ? 'send-stop-btn stop' : 'send-stop-btn send'}
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
      className={active ? 'slash-popup-item active' : 'slash-popup-item'}
      ref={itemRef}
      onMouseEnter={onHover}
      onClick={onChoose}
    >
      <span className="cmd-name">/{command.name}</span>
      {command.input?.hint && <span className="cmd-hint">{command.input.hint}</span>}
      <span className="cmd-desc">{command.description}</span>
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

  return <div className="input-resize-handle" id="resizeHandle" onMouseDown={onMouseDown} />;
}
