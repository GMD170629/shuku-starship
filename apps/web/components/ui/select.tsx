'use client';

import { Check, ChevronDown } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from './cn';

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectProps<TValue extends string> = {
  value: TValue;
  options: SelectOption[];
  onChange: (value: TValue) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  size?: 'sm' | 'md';
  tone?: 'light' | 'blue' | 'dark';
  align?: 'left' | 'right';
};

const triggerTone = {
  light: 'border-slate-200 bg-white text-slate-700 shadow-sm hover:border-blue-200 hover:bg-slate-50',
  blue: 'border-blue-100 bg-white text-slate-700 shadow-sm hover:border-blue-200 hover:bg-blue-50/40',
  dark: 'border-slate-700 bg-slate-900 text-slate-100 hover:border-slate-500 hover:bg-slate-800'
};

const menuTone = {
  light: 'border-slate-200 bg-white text-slate-700 shadow-xl shadow-slate-200/60',
  blue: 'border-blue-100 bg-white text-slate-700 shadow-xl shadow-blue-100/70',
  dark: 'border-slate-700 bg-slate-900 text-slate-100 shadow-xl shadow-black/30'
};

const optionTone = {
  light: {
    active: 'bg-blue-50 text-blue-700',
    idle: 'text-slate-600 hover:bg-slate-50',
    selected: 'text-blue-700'
  },
  blue: {
    active: 'bg-blue-50 text-blue-700',
    idle: 'text-slate-600 hover:bg-blue-50/60',
    selected: 'text-blue-700'
  },
  dark: {
    active: 'bg-slate-800 text-white',
    idle: 'text-slate-300 hover:bg-slate-800',
    selected: 'text-blue-300'
  }
};

export function Select<TValue extends string>({
  value,
  options,
  onChange,
  placeholder = '请选择',
  ariaLabel,
  className,
  triggerClassName,
  menuClassName,
  size = 'md',
  tone = 'light',
  align = 'left'
}: SelectProps<TValue>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const selectedIndex = useMemo(() => options.findIndex((option) => option.value === value), [options, value]);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const enabledOptions = options.filter((option) => !option.disabled);

  useEffect(() => {
    if (open) setActiveIndex(selectedIndex >= 0 ? selectedIndex : Math.max(0, options.findIndex((option) => !option.disabled)));
  }, [open, options, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  function moveActive(direction: 1 | -1) {
    if (enabledOptions.length === 0) return;
    const currentEnabledIndex = enabledOptions.findIndex((option) => option.value === options[activeIndex]?.value);
    const nextEnabled = enabledOptions[(currentEnabledIndex + direction + enabledOptions.length) % enabledOptions.length];
    setActiveIndex(options.findIndex((option) => option.value === nextEnabled.value));
  }

  function commit(nextValue: string) {
    const option = options.find((item) => item.value === nextValue);
    if (!option || option.disabled) return;
    onChange(nextValue as TValue);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      commit(options[activeIndex]?.value);
    }
  }

  return (
    <div ref={rootRef} className={cn('relative inline-flex min-w-[132px]', className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        onClick={() => setOpen((next) => !next)}
        onKeyDown={onKeyDown}
        className={cn(
          'inline-flex w-full items-center justify-between gap-3 rounded-2xl border font-medium outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100',
          size === 'sm' ? 'h-9 px-3 text-xs' : 'h-11 px-4 text-sm',
          triggerTone[tone],
          triggerClassName
        )}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown size={16} className={cn('shrink-0 transition', open && 'rotate-180')} />
      </button>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          className={cn(
            'absolute top-full z-40 mt-2 max-h-72 min-w-full overflow-auto rounded-2xl border p-1.5',
            align === 'right' ? 'right-0' : 'left-0',
            menuTone[tone],
            menuClassName
          )}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={option.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(option.value)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none transition disabled:cursor-not-allowed disabled:opacity-40',
                  isActive ? optionTone[tone].active : optionTone[tone].idle,
                  isSelected && optionTone[tone].selected
                )}
              >
                <span className="truncate">{option.label}</span>
                {isSelected ? <Check size={15} className="shrink-0" /> : <span className="h-[15px] w-[15px] shrink-0" />}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
