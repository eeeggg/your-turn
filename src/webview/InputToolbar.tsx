import type { SessionModeState } from '@agentclientprotocol/sdk';
import { Fragment, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import {
  categoryIcon,
  configPickers,
  currentValue,
  isOpen,
  showsModePicker,
  tooltipText,
  valueGroups,
  type PickerId,
  type PickerItemId,
  type SelectConfigOption,
} from '@/webview/Pickers';
import { useChatState, useDispatch } from '@/webview/StoreContext';

/** The hovered item's element, which the tooltip is placed beside. */
type Anchor = RefObject<HTMLElement | null>;

const modePicker: PickerId = { kind: 'mode' };

/** The row above the prompt box: the session's pickers and their shared tooltip. */
export function InputToolbar() {
  const pickers = useChatState((state) => state.pickers);
  const anchorRef = useRef<HTMLElement>(null);

  return (
    <>
      <div className="picker-row" id="configOptionsContainer">
        {configPickers(pickers).map((option) => {
          const picker: PickerId = { kind: 'config', configId: option.id };
          return (
            <ConfigPicker key={option.id} picker={picker} option={option} open={isOpen(pickers, picker)} anchorRef={anchorRef} />
          );
        })}
      </div>
      <ModePicker
        modes={showsModePicker(pickers) ? pickers.modes : null}
        open={isOpen(pickers, modePicker)}
        anchorRef={anchorRef}
      />
      <span className="toolbar-spacer" />
      <PickerTooltip text={tooltipText(pickers)} hovered={pickers.hovered} anchorRef={anchorRef} />
    </>
  );
}

function ConfigPicker({
  picker,
  option,
  open,
  anchorRef,
}: {
  picker: PickerId;
  option: SelectConfigOption;
  open: boolean;
  anchorRef: Anchor;
}) {
  const dispatch = useDispatch();
  const current = currentValue(option);
  return (
    <div className="picker-wrap" data-config-id={option.id}>
      <PickerButton
        picker={picker}
        title={current?.description || option.description || option.name}
        icon={categoryIcon(option.category)}
        label={current?.name || option.name || 'Option'}
      />
      <PickerDropdown open={open}>
        {valueGroups(option).map((group) => (
          <Fragment key={group.id}>
            {group.header !== undefined && <div className="picker-dropdown-group-header">{group.header}</div>}
            {group.values.map((value) => (
              <PickerItem
                key={value.value}
                itemId={{ picker, item: value.value }}
                dataValue={value.value}
                label={value.name || value.value}
                description={value.description}
                selected={value.value === option.currentValue}
                onChoose={() => dispatch({ type: 'configValueChosen', configId: option.id, value: value.value })}
                anchorRef={anchorRef}
              />
            ))}
          </Fragment>
        ))}
      </PickerDropdown>
    </div>
  );
}

/** Shown, with `modes` set, only for agents that have no config options. */
function ModePicker({ modes, open, anchorRef }: { modes: SessionModeState | null; open: boolean; anchorRef: Anchor }) {
  const dispatch = useDispatch();
  const current = modes?.availableModes.find((mode) => mode.id === modes.currentModeId);
  return (
    <div className={modes ? 'picker-wrap' : 'picker-wrap hidden'} id="modePickerWrap">
      <PickerButton
        picker={modePicker}
        id="modePickerBtn"
        labelId="modePickerLabel"
        title="Select mode"
        labelTitle={current?.description ?? undefined}
        icon="⚡"
        label={current?.name ?? 'Mode'}
      />
      <PickerDropdown id="modeDropdown" open={open}>
        {modes?.availableModes.map((mode) => (
          <PickerItem
            key={mode.id}
            itemId={{ picker: modePicker, item: mode.id }}
            label={mode.name}
            description={mode.description}
            selected={mode.id === modes.currentModeId}
            onChoose={() => dispatch({ type: 'modeChosen', modeId: mode.id })}
            anchorRef={anchorRef}
          />
        ))}
      </PickerDropdown>
    </div>
  );
}

interface PickerButtonProps {
  picker: PickerId;
  id?: string;
  labelId?: string;
  title: string;
  labelTitle?: string | undefined;
  icon: string;
  label: string;
}

function PickerButton({ picker, id, labelId, title, labelTitle, icon, label }: PickerButtonProps) {
  const dispatch = useDispatch();
  return (
    <button
      className="picker-btn"
      id={id}
      title={title}
      onClick={(event) => {
        // A click that reaches the document closes the pickers.
        event.stopPropagation();
        dispatch({ type: 'pickerToggled', picker });
      }}
    >
      <span className="picker-icon">{icon}</span>
      <span className="picker-label" id={labelId} title={labelTitle}>
        {label}
      </span>
      <span className="picker-chevron">▾</span>
    </button>
  );
}

function PickerDropdown({ id, open, children }: { id?: string; open: boolean; children: ReactNode }) {
  const dispatch = useDispatch();
  return (
    <div
      className={open ? 'picker-dropdown open' : 'picker-dropdown'}
      id={id}
      // Scrolling would leave the tooltip beside an item that has moved.
      onScroll={() => dispatch({ type: 'pickerItemLeft' })}
    >
      {children}
    </div>
  );
}

interface PickerItemProps {
  itemId: PickerItemId;
  dataValue?: string;
  label: string;
  description: string | null | undefined;
  selected: boolean;
  onChoose(): void;
  anchorRef: Anchor;
}

function PickerItem({ itemId, dataValue, label, description, selected, onChoose, anchorRef }: PickerItemProps) {
  const dispatch = useDispatch();
  return (
    <div
      className={selected ? 'picker-dropdown-item selected' : 'picker-dropdown-item'}
      data-value={dataValue}
      title={description || undefined}
      onClick={(event) => {
        event.stopPropagation();
        onChoose();
      }}
      onMouseEnter={(event) => {
        anchorRef.current = event.currentTarget;
        dispatch({ type: 'pickerItemHovered', hovered: itemId });
      }}
      onMouseLeave={() => dispatch({ type: 'pickerItemLeft' })}
    >
      <span className="check">{selected ? '✓' : ''}</span>
      <span className="item-label">{label}</span>
    </div>
  );
}

function PickerTooltip({ text, hovered, anchorRef }: { text: string | null; hovered: PickerItemId | null; anchorRef: Anchor }) {
  const tooltip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (tooltip.current && anchorRef.current && hovered && text) {
      place(tooltip.current, anchorRef.current);
    }
  }, [hovered, text, anchorRef]);
  return (
    <div ref={tooltip} className={text ? 'picker-tooltip visible' : 'picker-tooltip'} id="pickerTooltip" role="tooltip">
      {text}
    </div>
  );
}

/** Beside the item's dropdown, on its left unless there is no room there, and inside the viewport. */
function place(tooltip: HTMLElement, item: HTMLElement): void {
  // Measured far off-screen, where the viewport edge cannot squeeze its width.
  tooltip.style.left = '-9999px';
  tooltip.style.top = '-9999px';
  const dropdownElement = item.closest('.picker-dropdown');
  if (!dropdownElement) {
    return;
  }
  const dropdown = dropdownElement.getBoundingClientRect();
  const tip = tooltip.getBoundingClientRect();
  const gap = 6;
  const margin = 4;

  let left = dropdown.left - tip.width - gap;
  if (left < margin) {
    left = dropdown.right + gap;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - tip.width - margin));
  const top = Math.max(margin, Math.min(item.getBoundingClientRect().top, window.innerHeight - tip.height - margin));

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}
