'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-blue-600 text-white shadow-sm hover:bg-blue-700',
  secondary: 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100',
  danger: 'border border-red-100 bg-red-50 text-red-700 hover:bg-red-100'
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: ReactNode;
  icon?: LucideIcon;
  variant?: ButtonVariant;
};

export function Button({ children, icon: Icon, variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-medium transition active:scale-[0.98]',
        variants[variant],
        className
      )}
      {...props}
    >
      {Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}
