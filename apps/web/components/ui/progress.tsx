import { cn } from './cn';

type ProgressProps = {
  value: number;
  className?: string;
};

export function Progress({ value, className = '' }: ProgressProps) {
  const clampedValue = Math.max(0, Math.min(100, value));

  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-slate-100', className)}>
      <div className="h-full rounded-full bg-blue-600" style={{ width: `${clampedValue}%` }} />
    </div>
  );
}
