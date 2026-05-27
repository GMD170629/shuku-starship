'use client';

import { CheckCircle2, Copy, FileText, RefreshCw, Tags, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';

function MetaForm() {
  const fields = [
    ['标题', '星屑魔女与机械书库'],
    ['作者', '青木遥'],
    ['类型', '漫画'],
    ['标签', '科幻, 冒险, 连载中'],
    ['目标书架', '漫画收藏']
  ];

  return (
    <div className="mt-5 space-y-4">
      {fields.map(([label, value]) => (
        <label key={label} className="block">
          <span className="text-sm text-slate-500">{label}</span>
          <input defaultValue={value} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none focus:border-blue-500" />
        </label>
      ))}
    </div>
  );
}

export function OrganizePage() {
  const files = ['unknown_2026_0519.cbz', 'docker-home-server-v2.pdf', 'archive_volume_03.zip', 'scan_technical_notes.epub', 'duplicate_manga_12.cbz'];

  return (
    <div className="space-y-6">
      <PageTitle title="待整理" desc="处理新扫描、识别失败、重复和缺少元数据的读物。" action={<Button icon={RefreshCw}>批量重新识别</Button>} />
      <div className="grid h-[720px] grid-cols-12 gap-5">
        <div className="col-span-3 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex gap-2 overflow-x-auto pb-3">
            {['待识别', '识别失败', '疑似重复', '缺少封面'].map((item, index) => (
              <Badge key={item} tone={index === 1 ? 'red' : index === 2 ? 'amber' : 'slate'}>{item}</Badge>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            {files.map((file, index) => (
              <div key={file} className={cn('rounded-2xl border p-3 text-sm', index === 0 ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white')}>
                <div className="font-medium">{file}</div>
                <div className="mt-1 text-xs text-slate-500">{['等待处理', '识别失败', '疑似重复', '缺少封面', '已识别'][index]}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="col-span-5 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold">文件预览</h2>
          <div className="mt-5 flex h-[580px] items-center justify-center rounded-3xl bg-slate-100">
            <div className="w-64 rounded-[28px] bg-gradient-to-br from-slate-400 to-slate-700 p-8 text-white shadow-xl">
              <FileText size={42} />
              <div className="mt-20 text-2xl font-semibold">未知读物</div>
              <div className="mt-2 text-sm text-white/70">CBZ · 326MB · 284 pages</div>
            </div>
          </div>
        </div>
        <div className="col-span-4 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold">元数据编辑</h2>
          <MetaForm />
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button icon={CheckCircle2}>保存识别</Button>
            <Button variant="secondary" icon={Copy}>合并分卷</Button>
            <Button variant="secondary" icon={Tags}>添加标签</Button>
            <Button variant="danger" icon={X}>忽略文件</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
