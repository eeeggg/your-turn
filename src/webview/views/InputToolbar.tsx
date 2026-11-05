import { Fragment, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { Picker } from '@/shared/WebviewMessages';
import {
  categoryIcon,
  currentValue,
  isOpen,
  tooltipText,
  type PickerItemId
} from '@/webview/state/Pickers';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';

/** The hovered item's element, which the tooltip is placed beside. */
type Anchor = RefObject<HTMLElement | null>;

/** The row above the prompt box: the session's pickers and their shared tooltip. */
export function InputToolbar() {
  const pickers = useSelector((state) => state.pickers);
  const anchorRef = useRef<HTMLElement>(null);

  return (
    <>
      <div className="picker-row contents" id="pickers">
        {pickers.pickers.map((picker) => (
          <PickerView key={picker.id} picker={picker} open={isOpen(pickers, picker.id)} anchorRef={anchorRef} />
        ))}
      </div>
      <span className="toolbar-spacer flex-1" />
      <PickerTooltip text={tooltipText(pickers)} hovered={pickers.hovered} anchorRef={anchorRef} />
    </>
  );
}

function PickerView({ picker, open, anchorRef }: { picker: Picker; open: boolean; anchorRef: Anchor }) {
  const dispatch = useDispatch();
  const current = currentValue(picker);
  return (
    <div className="picker-wrap relative max-w-full min-w-0" data-picker-id={picker.id}>
      <PickerButton
        pickerId={picker.id}
        title={current?.description || picker.description || picker.name}
        icon={categoryIcon(picker.category)}
        label={current?.name || picker.name || 'Option'}
      />
      <PickerDropdown open={open}>
        {picker.groups.map((group, index) => (
          <Fragment key={index}>
            {group.header !== null && (
              <div className="picker-dropdown-group-header pointer-events-none px-2.5 pt-1.5 pb-0.5 text-2xs tracking-[0.05em] text-muted-foreground uppercase not-first:mt-1 not-first:border-t not-first:border-border">
                {group.header}
              </div>
            )}
            {group.values.map((value) => (
              <PickerItem
                key={value.id}
                itemId={{ pickerId: picker.id, value: value.id }}
                label={value.name || value.id}
                description={value.description}
                selected={value.id === picker.current}
                onChoose={() => dispatch({ type: 'pickerValueChosen', pickerId: picker.id, value: value.id })}
                anchorRef={anchorRef}
              />
            ))}
          </Fragment>
        ))}
      </PickerDropdown>
    </div>
  );
}

interface PickerButtonProps {
  pickerId: string;
  title: string;
  icon: string;
  label: string;
}

function PickerButton({ pickerId, title, icon, label }: PickerButtonProps) {
  const dispatch = useDispatch();
  return (
    <button
      className="picker-btn inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-[3px] px-2 py-0.5 text-control whitespace-nowrap text-foreground opacity-80 hover:bg-toolbar-hover hover:opacity-100"
      title={title}
      onClick={(event) => {
        // A click that reaches the document closes the pickers.
        event.stopPropagation();
        dispatch({ type: 'pickerToggled', pickerId });
      }}
    >
      <span className="picker-icon flex-none text-[14px]">{icon}</span>
      <span className="picker-label min-w-0 truncate">{label}</span>
      <span className="picker-chevron flex-none text-[10px] opacity-60">▾</span>
    </button>
  );
}

function PickerDropdown({ open, children }: { open: boolean; children: ReactNode }) {
  const dispatch = useDispatch();
  return (
    <div
      className={`picker-dropdown ${open ? 'open block' : 'hidden'} absolute bottom-full left-0 z-100 mb-1 max-h-60 max-w-[min(420px,calc(100vw-16px))] min-w-45 overflow-y-auto rounded-sm border border-popover-border bg-popover shadow-popover`}
      // Scrolling would leave the tooltip beside an item that has moved.
      onScroll={() => dispatch({ type: 'pickerItemLeft' })}
    >
      {children}
    </div>
  );
}

interface PickerItemProps {
  itemId: PickerItemId;
  label: string;
  description: string | null;
  selected: boolean;
  onChoose: () => void;
  anchorRef: Anchor;
}

function PickerItem({ itemId, label, description, selected, onChoose, anchorRef }: PickerItemProps) {
  const dispatch = useDispatch();
  return (
    <div
      className={`picker-dropdown-item ${selected ? 'selected bg-selected text-selected-foreground' : 'text-popover-foreground hover:bg-hover'} flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-control`}
      data-value={itemId.value}
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
      <span className="check w-3.5 flex-none text-center">{selected ? '✓' : ''}</span>
      <span className="item-label min-w-0 flex-auto truncate">{label}</span>
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
    <div
      ref={tooltip}
      className={`picker-tooltip ${text ? 'visible block' : 'hidden'} pointer-events-none fixed z-300 max-w-70 rounded-sm border border-tooltip-border bg-tooltip px-2.5 py-1.5 text-control leading-[1.4] wrap-anywhere whitespace-normal text-tooltip-foreground shadow-popover`}
      id="pickerTooltip"
      role="tooltip"
    >
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
