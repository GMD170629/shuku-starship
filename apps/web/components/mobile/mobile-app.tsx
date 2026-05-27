'use client';

import { Archive, BookMarked, BookOpen, CheckCircle2, ChevronLeft, ChevronRight, Download, Home, Moon, Search, Settings, User, Wifi } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Cover } from '../book/cover';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Progress } from '../ui/progress';
import { books, type Book } from '../../data/mock-books';

type MobilePage = 'mhome' | 'mshelf' | 'msearch' | 'mprofile' | 'mdetail' | 'mreader';

function MobileFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto h-[844px] w-[390px] overflow-hidden rounded-[42px] border-[10px] border-slate-900 bg-[#F8FAFC] shadow-2xl">
      <div className="h-full overflow-hidden">{children}</div>
    </div>
  );
}

function MiniMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-3">
      <div className="font-semibold text-slate-950">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{label}</div>
    </div>
  );
}

function MobileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-7">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{title}</h2>
        <span className="text-xs text-blue-600">更多</span>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function MobileBookRow({ book, onClick }: { book: Book; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-3xl bg-white p-3 text-left shadow-sm">
      <Cover book={book} className="h-20 w-14" small />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{book.title}</div>
        <div className="mt-1 text-xs text-slate-500">{book.author} · {book.type}</div>
        <Progress value={book.progress} className="mt-3" />
      </div>
      <span className="text-xs text-slate-500">{book.progress}%</span>
    </button>
  );
}

function MobileHome({ setMobilePage }: { setMobilePage: (page: MobilePage) => void }) {
  return (
    <div className="p-5">
      <div className="flex items-center justify-between pt-2">
        <div>
          <div className="text-sm text-slate-500">早上好，Gu</div>
          <h1 className="text-2xl font-semibold">继续你的阅读</h1>
        </div>
        <Badge tone="green">已同步</Badge>
      </div>
      <div className="mt-6 rounded-[28px] bg-white p-4 shadow-sm">
        <div className="flex gap-4">
          <Cover book={books[0]} className="h-44 flex-1" />
          <div className="w-40 py-1">
            <div className="text-lg font-semibold leading-tight">星屑魔女与机械书库</div>
            <div className="mt-2 text-xs text-slate-500">第 12 话 · 68%</div>
            <Progress value={68} className="mt-4" />
            <Button className="mt-5 w-full" icon={BookOpen} onClick={() => setMobilePage('mreader')}>继续阅读</Button>
          </div>
        </div>
      </div>
      <MobileSection title="最近新增">
        {books.slice(1, 4).map((book) => <MobileBookRow key={book.id} book={book} onClick={() => setMobilePage('mdetail')} />)}
      </MobileSection>
      <MobileSection title="正在阅读">
        {books.filter((book) => book.status === '在读').slice(0, 3).map((book) => <MobileBookRow key={book.id} book={book} onClick={() => setMobilePage('mdetail')} />)}
      </MobileSection>
    </div>
  );
}

function MobileShelf({ setMobilePage, search = false }: { setMobilePage: (page: MobilePage) => void; search?: boolean }) {
  return (
    <div className="p-5">
      <h1 className="pt-2 text-2xl font-semibold">{search ? '搜索' : '我的书架'}</h1>
      <div className="mt-4 flex h-11 items-center gap-2 rounded-2xl bg-white px-4 shadow-sm">
        <Search size={17} className="text-slate-400" />
        <input placeholder="搜索书名或作者" className="w-full bg-transparent text-sm outline-none" />
      </div>
      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {['全部', '在读', '想看', '已读', '收藏'].map((item, index) => (
          <button className={cn('shrink-0 rounded-full px-4 py-2 text-sm', index === 0 ? 'bg-blue-600 text-white' : 'bg-white text-slate-600')} key={item}>{item}</button>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-4">
        {books.map((book) => (
          <button key={book.id} onClick={() => setMobilePage('mdetail')} className="rounded-[24px] bg-white p-3 text-left shadow-sm">
            <Cover book={book} className="h-40 w-full" small />
            <div className="mt-3 line-clamp-1 text-sm font-semibold">{book.title}</div>
            <div className="mt-1 text-xs text-slate-500">{book.progress}% · {book.author}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function MobileDetail({ setMobilePage }: { setMobilePage: (page: MobilePage) => void }) {
  const book = books[0];

  return (
    <div className="p-5">
      <button onClick={() => setMobilePage('mshelf')} className="mb-4 flex items-center gap-1 text-sm text-slate-500">
        <ChevronLeft size={16} />返回
      </button>
      <div className="flex gap-4">
        <Cover book={book} className="h-48 w-32" />
        <div className="flex-1 pt-2">
          <h1 className="text-xl font-semibold leading-tight">{book.title}</h1>
          <div className="mt-2 text-sm text-slate-500">{book.author}</div>
          <div className="mt-3 flex flex-wrap gap-1">{book.tags.slice(0, 2).map((tag) => <Badge key={tag}>{tag}</Badge>)}</div>
          <Progress value={68} className="mt-5" />
          <Button className="mt-5 w-full" onClick={() => setMobilePage('mreader')}>继续阅读</Button>
        </div>
      </div>
      <p className="mt-6 text-sm leading-7 text-slate-600">{book.desc}</p>
      <h2 className="mt-7 font-semibold">章节列表</h2>
      <div className="mt-3 space-y-2">
        {Array.from({ length: 8 }, (_, index) => (
          <button key={index} onClick={() => setMobilePage('mreader')} className="flex w-full items-center justify-between rounded-2xl bg-white p-4 text-left shadow-sm">
            <span>第 {index + 1} 话 · 目录节点</span>
            <ChevronRight size={16} className="text-slate-400" />
          </button>
        ))}
      </div>
    </div>
  );
}

function MobileReader({ setMobilePage }: { setMobilePage: (page: MobilePage) => void }) {
  const [tools, setTools] = useState(true);
  const [night, setNight] = useState(true);

  return (
    <div onClick={() => setTools((value) => !value)} className={cn('relative h-full', night ? 'bg-[#111827] text-slate-100' : 'bg-[#F5F1E8] text-slate-900')}>
      {tools ? (
        <div onClick={(event) => event.stopPropagation()} className="absolute inset-x-0 top-0 z-10 flex h-16 items-center justify-between bg-black/20 px-4 backdrop-blur">
          <button onClick={() => setMobilePage('mdetail')}><ChevronLeft /></button>
          <div className="text-sm font-medium">第 12 话</div>
          <CheckCircle2 size={18} className="text-emerald-400" />
        </div>
      ) : null}
      <div className="px-7 pt-24 text-lg leading-[2.05]">
        <h1 className="mb-8 text-xl font-semibold">失落的目录索引</h1>
        <p>旧服务器的风扇声在地下书库里缓慢回响。她将最后一枚索引片插入读取器，屏幕上浮现出被遗忘的分卷名称。</p>
        <p className="mt-6">每一本书都记录着路径、封面、标签与最后一次翻阅的位置。当同步指示灯转为绿色，阅读便从任何设备继续。</p>
      </div>
      {tools ? (
        <div onClick={(event) => event.stopPropagation()} className="absolute inset-x-0 bottom-0 z-10 bg-black/20 p-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <Button variant="ghost" icon={ChevronLeft}>上一章</Button>
            <Progress value={68} className="flex-1" />
            <Button variant="ghost" icon={ChevronRight}>下一章</Button>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2 text-xs">
            <button className="rounded-2xl bg-white/10 p-3">字号 A+</button>
            <button className="rounded-2xl bg-white/10 p-3">亮度</button>
            <button className="rounded-2xl bg-white/10 p-3">行距</button>
            <button onClick={() => setNight((value) => !value)} className="rounded-2xl bg-white/10 p-3">{night ? '护眼' : '夜间'}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MobileProfile() {
  const rows = [
    { title: 'NAS 连接状态', icon: Wifi, value: '正常' },
    { title: '本地缓存', icon: Download, value: '4.8GB' },
    { title: '备份入口', icon: Archive, value: '昨晚 03:00' },
    { title: '主题切换', icon: Moon, value: '跟随系统' },
    { title: '系统设置', icon: Settings, value: '路径/同步/安全' }
  ];

  return (
    <div className="p-5">
      <div className="pt-3 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-slate-900 text-white"><User size={32} /></div>
        <h1 className="mt-3 text-xl font-semibold">Gu 的私人书库</h1>
        <div className="mt-1 text-sm text-slate-500">NAS 已连接 · 2 分钟前同步</div>
      </div>
      <div className="mt-6 grid grid-cols-3 gap-3 text-center">
        <MiniMetric value="1286" label="总读物" />
        <MiniMetric value="8.5h" label="本周" />
        <MiniMetric value="14" label="连续" />
      </div>
      <div className="mt-6 space-y-3">
        {rows.map(({ title, icon: Icon, value }) => (
          <div key={title} className="flex items-center justify-between rounded-3xl bg-white p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <Icon size={18} className="text-blue-600" />
              <span className="font-medium">{title}</span>
            </div>
            <span className="text-sm text-slate-500">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MobileApp() {
  const [mobilePage, setMobilePage] = useState<MobilePage>('mhome');
  const tabs = [
    { key: 'mhome' as const, icon: Home, label: '首页' },
    { key: 'mshelf' as const, icon: BookMarked, label: '书架' },
    { key: 'msearch' as const, icon: Search, label: '搜索' },
    { key: 'mprofile' as const, icon: User, label: '我的' }
  ];

  return (
    <MobileFrame>
      <div className="flex h-full flex-col">
        <div className="flex-1 overflow-auto">
          {mobilePage === 'mhome' ? <MobileHome setMobilePage={setMobilePage} /> : null}
          {mobilePage === 'mshelf' ? <MobileShelf setMobilePage={setMobilePage} /> : null}
          {mobilePage === 'mdetail' ? <MobileDetail setMobilePage={setMobilePage} /> : null}
          {mobilePage === 'mreader' ? <MobileReader setMobilePage={setMobilePage} /> : null}
          {mobilePage === 'mprofile' ? <MobileProfile /> : null}
          {mobilePage === 'msearch' ? <MobileShelf setMobilePage={setMobilePage} search /> : null}
        </div>
        {mobilePage !== 'mreader' ? (
          <div className="grid h-20 grid-cols-4 border-t border-slate-200 bg-white/90 backdrop-blur-xl">
            {tabs.map(({ key, icon: Icon, label }) => (
              <button key={key} onClick={() => setMobilePage(key)} className={cn('flex flex-col items-center justify-center gap-1 text-xs', mobilePage === key ? 'text-blue-600' : 'text-slate-400')}>
                <Icon size={20} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </MobileFrame>
  );
}
