'use client';
import { useState } from 'react';

export function ReaderToolbar() {
  const [visible, setVisible] = useState(true);
  return (
    <div className="space-y-3">
      <button onClick={() => setVisible((v) => !v)} className="rounded-md border px-3 py-2 text-sm">
        {visible ? '隐藏工具栏' : '显示工具栏'}
      </button>
      {visible && <div className="rounded-lg border bg-slate-50 p-3 text-sm">字号 - / + ｜ 目录 ｜ 进度</div>}
    </div>
  );
}
