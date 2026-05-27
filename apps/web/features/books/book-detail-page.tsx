'use client';

import { BookOpen, ChevronLeft, ChevronRight, Edit3, EyeOff, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { Progress } from '../../components/ui/progress';
import type { BookView } from '../../lib/books';

function Info({ label, value, green = false }: { label: string; value: string; green?: boolean }) {
  return (
    <div className="mt-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={cn('mt-1 break-words text-sm', green ? 'text-emerald-600' : 'text-slate-700')}>{value}</div>
    </div>
  );
}

export function BookDetailPage({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [book, setBook] = useState<BookView | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [coverBust, setCoverBust] = useState(0);
  const [form, setForm] = useState({
    title: '',
    author: '',
    description: '',
    format: 'UNKNOWN',
    tags: '',
    status: 'WANT'
  });

  const loadBook = useCallback(() => {
    fetch(`/api/books/${bookId}`)
      .then((response) => response.json() as Promise<{ ok: boolean; data?: { book: BookView }; error?: { message: string } }>)
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取读物失败');
        const nextBook = payload.data?.book ?? null;
        setBook(nextBook);
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
      <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <Cover book={displayBook} className="h-[360px] lg:col-span-3" size="large" />
          <div className="lg:col-span-6">
            <div className="flex flex-wrap gap-2">
              {book.tags.map((tag) => (
                <Badge key={tag} tone="blue">{tag}</Badge>
              ))}
              {book.tags.length === 0 ? <Badge>未标记</Badge> : null}
              {book.ignored ? <Badge tone="amber">已忽略</Badge> : null}
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">《{book.title}》</h1>
            <p className="mt-2 text-slate-500">{book.author} · {book.type} · {book.format}</p>
            <p className="mt-6 max-w-2xl text-sm leading-7 text-slate-600">{book.desc}</p>
            <div className="mt-6 rounded-3xl bg-slate-50 p-4">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">阅读进度</span>
                <span className="font-medium">{book.progress}% · {book.chapter}</span>
              </div>
              <Progress value={book.progress} className="mt-3" />
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button icon={BookOpen} onClick={() => router.push(`/reader/${book.id}`)}>{book.progress > 0 ? '继续阅读' : '开始阅读'}</Button>
              <Button variant="secondary" icon={Edit3} onClick={() => setEditing((value) => !value)}>编辑信息</Button>
              <Button disabled={saving} variant="secondary" icon={RefreshCw} onClick={() => postAction(`/api/books/${book.id}/rescan`, '已创建重新扫描任务')}>重新扫描</Button>
              <Button disabled={saving} variant="secondary" icon={RefreshCw} onClick={() => postAction(`/api/books/${book.id}/cover/regenerate`, '封面已重新生成', { refreshCover: true })}>重新生成封面</Button>
              <Button disabled={saving} variant={book.ignored ? 'secondary' : 'danger'} icon={book.ignored ? EyeOff : Trash2} onClick={() => setIgnored(!book.ignored)}>{book.ignored ? '恢复显示' : '忽略读物'}</Button>
            </div>
            {message ? <div className="mt-4 text-sm text-emerald-600">{message}</div> : null}
          </div>
          <div className="rounded-3xl bg-slate-50 p-5 lg:col-span-3">
            <h2 className="font-semibold">文件信息</h2>
            <Info label="源路径" value={book.path} />
            <Info label="文件大小" value={book.size} />
            <Info label="资源数量" value={`${book.files.length} 个文件`} />
            <Info label="添加时间" value={book.added} />
            <Info label="最后阅读" value={book.lastRead} />
            <Info label="同步状态" value="已同步" green />
          </div>
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
              <select value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300">
                <option value="TXT">TXT</option>
                <option value="PDF">PDF</option>
                <option value="IMAGE">图片</option>
                <option value="COMIC">漫画</option>
                <option value="EPUB">EPUB</option>
                <option value="UNKNOWN">未知</option>
              </select>
            </label>
            <label className="text-sm text-slate-600">
              阅读状态
              <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-slate-900 outline-none focus:border-blue-300">
                <option value="WANT">想读</option>
                <option value="READING">在读</option>
                <option value="FINISHED">已读</option>
              </select>
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
        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm lg:col-span-8">
          <h2 className="text-lg font-semibold">章节 / 页面资源</h2>
          <div className="mt-4 divide-y divide-slate-100">
            {book.files.map((file, index) => (
              <button key={file.id} onClick={() => router.push(`/reader/${book.id}`)} className="flex w-full items-center justify-between py-4 text-left hover:bg-slate-50">
                <div>
                  <div className="font-medium">{file.path.split('/').at(-1)}</div>
                  <div className="mt-1 text-xs text-slate-500">{file.mimeType} · {file.size}</div>
                </div>
                <div className="flex items-center gap-2">
                  {index === 0 ? <Badge tone="blue">阅读入口</Badge> : null}
                  <ChevronRight size={16} className="text-slate-400" />
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm lg:col-span-4">
          <h2 className="text-lg font-semibold">阅读状态</h2>
          <div className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">{book.status} · {book.progress}%</div>
        </div>
      </div>
    </div>
  );
}
