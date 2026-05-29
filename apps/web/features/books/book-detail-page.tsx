'use client';

import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, Edit3, EyeOff, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { Progress } from '../../components/ui/progress';
import { Select } from '../../components/ui/select';
import type { BookView } from '../../lib/books';

function Info({ label, value, green = false }: { label: string; value: string; green?: boolean }) {
  return (
    <div className="mt-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={cn('mt-1 break-words text-sm', green ? 'text-emerald-600' : 'text-slate-700')}>{value}</div>
    </div>
  );
}

const formatOptions = [
  { value: 'COMIC', label: '漫画' },
  { value: 'EPUB', label: 'EPUB' }
];

const statusOptions = [
  { value: 'WANT', label: '想读' },
  { value: 'READING', label: '在读' },
  { value: 'FINISHED', label: '已读' }
];

type ReadingUnitView = { id: string; unitType: string; title: string; href: string; mediaType?: string | null; sortOrder: number; size?: string | number | null };
type DetailMetadata = { language?: string | null; publisher?: string | null; publishedAt?: string | null; isbn?: string | null; items?: Array<{ source: string; metadataJson: unknown }> };

export function BookDetailPage({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [book, setBook] = useState<BookView | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [metadata, setMetadata] = useState<DetailMetadata | null>(null);
  const [readingUnits, setReadingUnits] = useState<ReadingUnitView[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [coverBust, setCoverBust] = useState(0);
  const [form, setForm] = useState({
    title: '',
    author: '',
    description: '',
    format: 'EPUB',
    tags: '',
    status: 'WANT'
  });

  const loadBook = useCallback(() => {
    fetch(`/api/books/${bookId}`)
      .then((response) => response.json() as Promise<{ ok: boolean; data?: { book: BookView; metadata?: DetailMetadata; readingUnits?: ReadingUnitView[] }; error?: { message: string } }>)
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取读物失败');
        const nextBook = payload.data?.book ?? null;
        setBook(nextBook);
        setMetadata(payload.data?.metadata ?? null);
        setReadingUnits(payload.data?.readingUnits ?? []);
        if (nextBook) {
          setForm({
            title: nextBook.title,
            author: nextBook.author === '未知作者' ? '' : nextBook.author,
            description: nextBook.desc === '暂无简介，可在详情页补充元数据。' ? '' : nextBook.desc,
            format: nextBook.formatValue,
            tags: nextBook.tags.join(', '),
            status: nextBook.statusValue
          });
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '读取读物失败'));
  }, [bookId]);

  useEffect(() => {
    loadBook();
  }, [loadBook]);

  const displayBook = useMemo(() => {
    if (!book || coverBust === 0) return book;
    return { ...book, coverUrl: `${book.coverUrl}${book.coverUrl.includes('?') ? '&' : '?'}v=${coverBust}` };
  }, [book, coverBust]);

  async function saveMetadata() {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/books/${bookId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          author: form.author,
          description: form.description,
          format: form.format,
          status: form.status,
          tags: form.tags.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean)
        })
      });
      const payload = (await response.json()) as { ok: boolean; data?: { book: BookView }; error?: { message: string } };
      if (!payload.ok || !payload.data?.book) throw new Error(payload.error?.message ?? '保存失败');
      setBook(payload.data.book);
      setEditing(false);
      setMessage('读物信息已保存');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function postAction(path: string, successMessage: string, options: { refreshCover?: boolean; refreshBook?: boolean } = {}) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(path, { method: 'POST' });
      const payload = (await response.json()) as { ok: boolean; data?: { book?: BookView }; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '操作失败');
      if (payload.data?.book) setBook(payload.data.book);
      if (options.refreshBook) loadBook();
      if (options.refreshCover) setCoverBust(Date.now());
      setMessage(successMessage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setSaving(false);
    }
  }

  async function setIgnored(ignored: boolean) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/books/${bookId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ignored })
      });
      const payload = (await response.json()) as { ok: boolean; data?: { book: BookView }; error?: { message: string } };
      if (!payload.ok || !payload.data?.book) throw new Error(payload.error?.message ?? '操作失败');
      setBook(payload.data.book);
      setMessage(ignored ? '读物已忽略' : '读物已恢复显示');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setSaving(false);
    }
  }

  if (error && !book) return <div className="rounded-3xl border border-red-100 bg-red-50 p-8 text-sm text-red-700">{error}</div>;
  if (!book || !displayBook) return <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">正在读取读物详情...</div>;

  return (
    <div className="space-y-6">
      <button onClick={() => router.push('/library')} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900">
        <ChevronLeft size={16} /> 返回书库
      </button>
      {error ? <div className="rounded-3xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[190px_minmax(0,1fr)_320px]">
          <Cover book={displayBook} className="aspect-[2/3] w-full max-w-[190px]" size="large" />
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2">
              {book.tags.map((tag) => (
                <Badge key={tag} tone="blue">{tag}</Badge>
              ))}
              {book.tags.length === 0 ? <Badge>未标记</Badge> : null}
              {book.ignored ? <Badge tone="amber">已忽略</Badge> : null}
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">《{book.title}》</h1>
            <p className="mt-2 text-slate-500">{book.author} · {book.type === 'comic' ? '漫画' : '电子书'} · {book.format}</p>
            <p className="mt-4 line-clamp-3 max-w-3xl text-sm leading-7 text-slate-600">{book.desc}</p>
            <div className="mt-5 rounded-2xl bg-slate-50 p-4">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">阅读进度</span>
                <span className="font-medium">{book.progress}% · {book.chapter}</span>
              </div>
              <Progress value={book.progress} className="mt-3" />
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button icon={BookOpen} onClick={() => router.push(`/reader/${book.id}`)}>{book.progress > 0 ? '继续阅读' : '开始阅读'}</Button>
              <Button variant="secondary" icon={Edit3} onClick={() => setEditing((value) => !value)}>编辑信息</Button>
              <Button disabled={saving} variant="secondary" icon={RefreshCw} onClick={() => postAction(`/api/books/${book.id}/cover/regenerate`, '封面已重新生成', { refreshCover: true })}>重新生成封面</Button>
              <Button disabled={saving} variant={book.ignored ? 'secondary' : 'danger'} icon={book.ignored ? EyeOff : Trash2} onClick={() => setIgnored(!book.ignored)}>{book.ignored ? '恢复显示' : '忽略读物'}</Button>
            </div>
            {message ? <div className="mt-4 text-sm text-emerald-600">{message}</div> : null}
          </div>
          <aside className="rounded-2xl bg-slate-50 p-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-2xl bg-white p-3">
                <div className="text-xs text-slate-400">{book.type === 'comic' ? '页数' : '章节数'}</div>
                <div className="mt-1 font-medium text-slate-900">{book.totalUnits || '未知'}</div>
              </div>
              <div className="rounded-2xl bg-white p-3">
                <div className="text-xs text-slate-400">文件大小</div>
                <div className="mt-1 font-medium text-slate-900">{book.size}</div>
              </div>
              <div className="rounded-2xl bg-white p-3">
                <div className="text-xs text-slate-400">最后阅读</div>
                <div className="mt-1 line-clamp-1 font-medium text-slate-900">{book.lastRead}</div>
              </div>
              <div className="rounded-2xl bg-white p-3">
                <div className="text-xs text-slate-400">同步状态</div>
                <div className={cn('mt-1 line-clamp-1 font-medium', book.lastReadAt ? 'text-emerald-600' : 'text-slate-900')}>{book.lastReadAt ? '有进度' : '暂无进度'}</div>
              </div>
            </div>
            <details className="group mt-3 rounded-2xl bg-white">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-3 text-sm font-medium text-slate-700">
                文件信息
                <ChevronDown size={16} className="text-slate-400 transition group-open:rotate-180" />
              </summary>
              <div className="border-t border-slate-100 px-3 pb-3">
                <Info label="源路径" value={book.path} />
                <Info label="文件哈希" value={book.fileHash} />
                <Info label="资源数量" value={`${book.files.length} 个文件`} />
                <Info label="添加时间" value={book.added} />
              </div>
            </details>
          </aside>
        </div>
      </div>
      {editing ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">编辑读物信息</h2>
          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="text-sm text-slate-600">
              标题
              <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600">
              作者
              <input value={form.author} onChange={(event) => setForm({ ...form, author: event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600">
              类型
              <Select value={form.format} options={formatOptions} onChange={(format) => setForm({ ...form, format })} ariaLabel="类型" className="mt-2 w-full" />
            </label>
            <label className="text-sm text-slate-600">
              阅读状态
              <Select value={form.status} options={statusOptions} onChange={(status) => setForm({ ...form, status })} ariaLabel="阅读状态" className="mt-2 w-full" />
            </label>
            <label className="text-sm text-slate-600 md:col-span-2">
              标签
              <input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="标签，用逗号分隔" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600 md:col-span-2">
              简介
              <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={5} className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-slate-900 outline-none focus:border-blue-300" />
            </label>
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setEditing(false)}>取消</Button>
            <Button disabled={saving} icon={Save} onClick={saveMetadata}>保存信息</Button>
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm lg:col-span-8">
          <h2 className="text-lg font-semibold">{book.type === 'comic' ? '漫画页面' : '章节列表'}</h2>
          <div className="mt-3 divide-y divide-slate-100">
            {readingUnits.length > 0 ? readingUnits.slice(0, 80).map((unit) => (
              <button key={unit.id} onClick={() => router.push(`/reader/${book.id}`)} className="flex w-full items-center justify-between py-3 text-left hover:bg-slate-50">
                <div>
                  <div className="font-medium">{unit.title}</div>
                  <div className="mt-1 text-xs text-slate-500">{unit.unitType === 'page' ? '漫画页' : '章节'} · {unit.mediaType ?? unit.href}</div>
                </div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>
            )) : (
              <button onClick={() => router.push(`/reader/${book.id}`)} className="flex w-full items-center justify-between py-4 text-left hover:bg-slate-50">
                <div className="text-sm text-slate-500">开始阅读</div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>
            )}
            {readingUnits.length > 80 ? <div className="py-4 text-sm text-slate-500">还有 {readingUnits.length - 80} 项未展开，进入阅读器可继续阅读。</div> : null}
          </div>
        </div>
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm lg:col-span-4">
          <h2 className="text-lg font-semibold">{book.type === 'comic' ? '漫画信息' : '出版信息'}</h2>
          <div className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">{book.status} · {book.progress}%</div>
          {book.type === 'ebook' ? (
            <>
              <Info label="ISBN" value={metadata?.isbn ?? '未知'} />
              <Info label="出版社" value={metadata?.publisher ?? '未知'} />
              <Info label="语言" value={metadata?.language ?? '未知'} />
            </>
          ) : (
            <>
              <Info label="系列" value={String((metadata?.items?.[0]?.metadataJson as any)?.comicInfo?.Series ?? (metadata?.items?.[0]?.metadataJson as any)?.comicInfo?.series ?? '未知')} />
              <Info label="卷数" value={String((metadata?.items?.[0]?.metadataJson as any)?.comicInfo?.Volume ?? (metadata?.items?.[0]?.metadataJson as any)?.comicInfo?.volume ?? '未知')} />
              <Info label="页数" value={`${book.totalUnits || '未知'}`} />
              <Info label="标签" value={book.tags.join(', ') || '无'} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
