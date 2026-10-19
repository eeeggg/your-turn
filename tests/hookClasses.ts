/** Classes that say what a chat view element is or what state it is in, as opposed to its Tailwind utilities. */
const hooks = new Set([
  'agent',
  'collapsed',
  'completed',
  'error',
  'failed',
  'load-overlay',
  'message',
  'pending',
  'plan',
  'plan-entry',
  'running',
  'send',
  'send-stop-btn',
  'stop',
  'streaming',
  'tc-icon',
  'thought-block',
  'turn',
  'turn-tools',
  'turn-tools-list',
  'user',
  'visible',
]);

/** The element's hook classes, in order, as one string. */
export function hookClasses(element: Element): string;
export function hookClasses(element: Element | null | undefined): string | undefined;
export function hookClasses(element: Element | null | undefined): string | undefined {
  return element ? [...element.classList].filter((name) => hooks.has(name)).join(' ') : undefined;
}
