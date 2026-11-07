import ChevronUp from 'lucide-react/icons/chevron-up';
import ChevronDown from 'lucide-react/icons/chevron-down';
import ChevronLeft from 'lucide-react/icons/chevron-left';
import ChevronRight from 'lucide-react/icons/chevron-right';

const icons = { up: ChevronUp, down: ChevronDown, left: ChevronLeft, right: ChevronRight };

export function Chevron({ direction, size = 14, className = '' }: {
  direction: 'up' | 'down' | 'left' | 'right'; size?: number; className?: string;
}) {
  const Icon = icons[direction];
  return (
    <Icon
      size={size}
      strokeWidth={2.25}
      aria-hidden="true"
      className={`flex-none ${className}`}
    />
  );
}
