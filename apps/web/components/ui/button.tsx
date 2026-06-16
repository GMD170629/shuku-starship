'use client';

import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700',
  secondary: 'border border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-950',
  danger: 'border border-red-100 bg-red-50 text-red-700 hover:border-red-200 hover:bg-red-100 hover:text-red-800'
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: ReactNode;
  icon?: LucideIcon;
  loading?: boolean;
  loadingText?: string;
  variant?: ButtonVariant;
};

export function Button({ children, icon: Icon, loading = false, loadingText, variant = 'primary', className = '', disabled, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 data-[loading=true]:opacity-100',
        variants[variant],
        className
      )}
      data-loading={loading ? 'true' : undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 size={16} className="animate-spin" strokeWidth={2.4} /> : Icon ? <Icon size={16} strokeWidth={2.2} /> : null}
      {loading && loadingText ? loadingText : children}
    </button>
  );
}
