const rotation = { up: '', down: 'rotate-180', left: '-rotate-90', right: 'rotate-90' };

export function Chevron({ direction, size = 14, className = '' }: {
  direction: 'up' | 'down' | 'left' | 'right'; size?: number; className?: string;
}) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" className={`flex-none ${rotation[direction]} ${className}`}>
    <path d="m4 10 4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
