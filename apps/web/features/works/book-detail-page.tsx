'use client';

import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, Database, Download, Edit3, EyeOff, RefreshCw, Save, Trash2, UploadCloud, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { useConfirm, useToast } from '../../components/ui/feedback';
import { Progress } from '../../components/ui/progress';
import { Select } from '../../components/ui/select';
import type { WorkView } from '../../types/work';
import { MetadataLookupModal } from './metadata-lookup-modal';

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

const publicationStatusOptions = [
  { value: 'UNKNOWN', label: '未知' },
  { value: 'ONGOING', label: '连载中' },
  { value: 'COMPLETED', label: '已完结' },
  { value: 'HIATUS', label: '休刊中' },
  { value: 'CANCELLED', label: '已腰斩' }
];

const trackingStatusOptions = [
  { value: 'NOT_TRACKING', label: '未追更' },
  { value: 'TRACKING', label: '追更中' },
  { value: 'PAUSED', label: '暂停追更' },
  { value: 'IGNORED', label: '忽略更新' }
];

function toDateTimeLocal(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function formatDateTime(value: string | null) {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString();
}

function localLatestLabel(book: WorkView) {
  const parts = [
    book.localLatestVolume !== null ? `第 ${book.localLatestVolume} 卷` : '',
    book.localLatestChapter !== null ? `第 ${book.localLatestChapter} 章/话` : '',
    book.localLatestTitle ?? ''
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '未记录';
}

function readableEditionId(book: WorkView | null) {
  if (!book) return null;
  return book.recentEditionId ?? book.editionId ?? book.primaryEditionId ?? book.editions.find((edition) => !edition.hidden)?.id ?? null;
}

type ReadingUnitView = { id: string; unitType: string; title: string; href: string; mediaType?: string | null; sortOrder: number; size?: string | number | null };
type DetailMetadata = { language?: string | null; publisher?: string | null; publishedAt?: string | null; isbn?: string | null; items?: Array<{ source: string; metadataJson: unknown }> };
type ComicSectionView = { id: string; title: string; index: number; fileId: string; pageCount: number; coverUrl: string };

export function BookDetailPage({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [book, setBook] = useState<WorkView | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [metadata, setMetadata] = useState<DetailMetadata | null>(null);
  const [readingUnits, setReadingUnits] = useState<ReadingUnitView[]>([]);
  const [comicSections, setComicSections] = useState<ComicSectionView[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [metadataLookupOpen, setMetadataLookupOpen] = useState(false);
  const [dangerActionOpen, setDangerActionOpen] = useState(false);
  const [coverBust, setCoverBust] = useState(0);
  const [form, setForm] = useState({
    title: '',
    author: '',
    description: '',
    seriesName: '',
    seriesIndex: '',
    publishedYear: '',
    format: 'EPUB',
    tags: '',
    status: 'WANT',
    publicationStatus: 'UNKNOWN',
    trackingStatus: 'NOT_TRACKING',
    localLatestVolume: '',
    localLatestChapter: '',
    localLatestTitle: '',
    localLatestAt: ''
  });
  const confirm = useConfirm();
  const toast = useToast();

  const loadBook = useCallback(() => {
    fetch(`/api/works/${bookId}`)
      .then((response) => response.json() as Promise<{ ok: boolean; data?: { book: WorkView; metadata?: DetailMetadata; readingUnits?: ReadingUnitView[]; comicSections?: ComicSectionView[] }; error?: { message: string } }>)
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取读物失败');
        const nextBook = payload.data?.book ?? null;
        setBook(nextBook);
        setMetadata(payload.data?.metadata ?? null);
        setReadingUnits(payload.data?.readingUnits ?? []);
        setComicSections(payload.data?.comicSections ?? []);
        if (nextBook) {
          setForm({
            title: nextBook.title,
            author: nextBook.author === '未知作者' ? '' : nextBook.author,
            description: nextBook.desc === '暂无简介，可在详情页补充元数据。' ? '' : nextBook.desc,
            seriesName: nextBook.seriesName ?? '',
            seriesIndex: nextBook.seriesIndex === null ? '' : String(nextBook.seriesIndex),
            publishedYear: nextBook.publishedYear === null ? '' : String(nextBook.publishedYear),
            format: nextBook.formatValue,
            tags: nextBook.tags.join(', '),
            status: nextBook.statusValue,
            publicationStatus: nextBook.publicationStatusValue,
            trackingStatus: nextBook.trackingStatusValue,
            localLatestVolume: nextBook.localLatestVolume === null ? '' : String(nextBook.localLatestVolume),
            localLatestChapter: nextBook.localLatestChapter === null ? '' : String(nextBook.localLatestChapter),
            localLatestTitle: nextBook.localLatestTitle ?? '',
            localLatestAt: toDateTimeLocal(nextBook.localLatestAt)
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
    setBusyAction('saveMetadata');
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/works/${bookId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          author: form.author,
          description: form.description,
          seriesName: form.seriesName,
          seriesIndex: form.seriesIndex,
          publishedYear: form.publishedYear,
          format: form.format,
          status: form.status,
          publicationStatus: form.publicationStatus,
          trackingStatus: form.trackingStatus,
          localLatestVolume: form.localLatestVolume,
          localLatestChapter: form.localLatestChapter,
          localLatestTitle: form.localLatestTitle,
          localLatestAt: form.localLatestAt,
          tags: form.tags.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean),
          organized: true
        })
      });
      const payload = (await response.json()) as { ok: boolean; data?: { book: WorkView }; error?: { message: string } };
      if (!payload.ok || !payload.data?.book) throw new Error(payload.error?.message ?? '保存失败');
      setBook(payload.data.book);
      setEditing(false);
      setMessage('读物信息已保存');
      toast.success('读物信息已保存');
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '保存失败';
      setError(nextError);
      toast.error('保存失败', nextError);
    } finally {
      setSaving(false);
      setBusyAction('');
    }
  }

  async function postAction(path: string, successMessage: string, options: { refreshCover?: boolean; refreshBook?: boolean; busyKey?: string } = {}) {
    setSaving(true);
    setBusyAction(options.busyKey ?? path);
    setError('');
    setMessage('');
    try {
      const response = await fetch(path, { method: 'POST' });
      const payload = (await response.json()) as { ok: boolean; data?: { book?: WorkView }; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '操作失败');
      if (payload.data?.book) setBook(payload.data.book);
      if (options.refreshBook) loadBook();
      if (options.refreshCover) setCoverBust(Date.now());
      setMessage(successMessage);
      toast.success(successMessage);
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '操作失败';
      setError(nextError);
      toast.error('操作失败', nextError);
    } finally {
      setSaving(false);
      setBusyAction('');
    }
  }

  async function moveVolume(volumeId: string, direction: 'up' | 'down') {
    setSaving(true);
    setBusyAction(`move:${volumeId}:${direction}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/works/${bookId}/volumes/${volumeId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction })
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '卷册顺序更新失败');
      loadBook();
      setMessage('卷册顺序已更新');
      toast.success('卷册顺序已更新');
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '卷册顺序更新失败';
      setError(nextError);
      toast.error('卷册顺序更新失败', nextError);
    } finally {
      setSaving(false);
      setBusyAction('');
    }
  }

  async function setIgnored(ignored: boolean) {
    setSaving(true);
    setBusyAction('ignored');
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/works/${bookId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ignored })
      });
      const payload = (await response.json()) as { ok: boolean; data?: { book: WorkView }; error?: { message: string } };
      if (!payload.ok || !payload.data?.book) throw new Error(payload.error?.message ?? '操作失败');
      setBook(payload.data.book);
      const successMessage = ignored ? '读物已忽略' : '读物已恢复显示';
      setMessage(successMessage);
      toast.success(successMessage);
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '操作失败';
      setError(nextError);
      toast.error('操作失败', nextError);
    } finally {
      setSaving(false);
      setBusyAction('');
    }
  }

  async function deleteRecord(skipConfirm = false) {
    if (!skipConfirm) {
      const confirmed = await confirm({
        title: '确认删除记录',
        description: `确认删除《${book?.title ?? '这本读物'}》的数据库记录吗？源文件不会被删除。`,
        confirmLabel: '删除记录',
        tone: 'danger'
      });
      if (!confirmed) return;
    }
    setDangerActionOpen(false);
    setSaving(true);
    setBusyAction('delete');
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/works/${bookId}`, { method: 'DELETE' });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '删除失败');
      setMessage('已删除数据库记录，源文件未删除');
      toast.success('已删除数据库记录', '源文件未删除');
      window.setTimeout(() => router.push('/library'), 700);
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '删除失败';
      setError(nextError);
      toast.error('删除失败', nextError);
      setSaving(false);
      setBusyAction('');
    }
  }

  function downloadPrimaryEdition() {
    const editionId = readableEditionId(book);
    if (!editionId) return;
    window.location.href = `/api/editions/${editionId}/file`;
  }

  async function uploadCover(file: File | null) {
    if (!file) return;
    setSaving(true);
    setBusyAction('uploadCover');
    setError('');
    setMessage('');
    try {
      const formData = new FormData();
      formData.append('cover', file);
      const response = await fetch(`/api/works/${bookId}/cover/upload`, { method: 'POST', body: formData });
      const payload = (await response.json()) as { ok: boolean; data?: { coverUrl: string }; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '上传封面失败');
      setCoverBust(Date.now());
      loadBook();
      setMessage('自定义封面已保存');
      toast.success('自定义封面已保存');
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '上传封面失败';
      setError(nextError);
      toast.error('上传封面失败', nextError);
    } finally {
      setSaving(false);
      setBusyAction('');
    }
  }

  if (error && !book) return <div className="rounded-3xl border border-red-100 bg-red-50 p-8 text-sm text-red-700">{error}</div>;
  if (!book || !displayBook) return <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">正在读取读物详情...</div>;
  const readerEditionId = readableEditionId(book);

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
              {book.trackingStatusValue === 'TRACKING' ? <Badge tone="green">追更中</Badge> : null}
              {book.trackingStatusValue !== 'TRACKING' && book.trackingStatusValue !== 'NOT_TRACKING' ? <Badge tone="amber">{book.trackingStatus}</Badge> : null}
              {book.publicationStatusValue !== 'UNKNOWN' ? <Badge tone={book.publicationStatusValue === 'ONGOING' ? 'green' : 'slate'}>{book.publicationStatus}</Badge> : null}
              {localLatestLabel(book) !== '未记录' ? <Badge tone="slate">{localLatestLabel(book)}</Badge> : null}
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
              <Button disabled={!readerEditionId} icon={BookOpen} onClick={() => readerEditionId && router.push(comicSections[0] ? `/reader/${readerEditionId}?volume=${encodeURIComponent(comicSections[0].id)}` : `/reader/${readerEditionId}`)}>{book.progress > 0 ? '继续阅读' : '开始阅读'}</Button>
              <Button disabled={!readerEditionId} variant="secondary" icon={Download} onClick={downloadPrimaryEdition}>下载</Button>
              <Button variant="secondary" icon={Edit3} onClick={() => setEditing((value) => !value)}>编辑信息</Button>
              <Button disabled={saving} variant="secondary" icon={Database} onClick={() => setMetadataLookupOpen(true)}>元数据识别</Button>
              <Button loading={busyAction === 'regenerateCover'} disabled={saving && busyAction !== 'regenerateCover'} variant="secondary" icon={RefreshCw} onClick={() => postAction(`/api/works/${book.id}/cover/regenerate`, '封面已重新生成', { refreshCover: true, busyKey: 'regenerateCover' })}>重新生成封面</Button>
              {book.ignored ? (
                <Button loading={busyAction === 'ignored'} disabled={saving && busyAction !== 'ignored'} variant="secondary" icon={EyeOff} onClick={() => setIgnored(false)}>恢复显示</Button>
              ) : (
                <Button loading={busyAction === 'ignored' || busyAction === 'delete'} loadingText={busyAction === 'delete' ? '删除中' : '处理中'} disabled={saving && !['ignored', 'delete'].includes(busyAction)} variant="danger" icon={Trash2} onClick={() => setDangerActionOpen(true)}>忽略/删除</Button>
              )}
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
              <div className="rounded-2xl bg-white p-3">
                <div className="text-xs text-slate-400">追更状态</div>
                <div className={cn('mt-1 line-clamp-1 font-medium', book.trackingStatusValue === 'TRACKING' ? 'text-emerald-600' : 'text-slate-900')}>{book.trackingStatus}</div>
              </div>
              <div className="rounded-2xl bg-white p-3">
                <div className="text-xs text-slate-400">本地最新</div>
                <div className="mt-1 line-clamp-1 font-medium text-slate-900">{localLatestLabel(book)}</div>
              </div>
              <div className="rounded-2xl bg-white p-3">
                <div className="text-xs text-slate-400">最新时间</div>
                <div className="mt-1 line-clamp-1 font-medium text-slate-900">{formatDateTime(book.localLatestAt)}</div>
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
            <label className="text-sm text-slate-600">
              出版状态
              <Select value={form.publicationStatus} options={publicationStatusOptions} onChange={(publicationStatus) => setForm({ ...form, publicationStatus })} ariaLabel="出版状态" className="mt-2 w-full" />
            </label>
            <label className="text-sm text-slate-600">
              追更状态
              <Select value={form.trackingStatus} options={trackingStatusOptions} onChange={(trackingStatus) => setForm({ ...form, trackingStatus })} ariaLabel="追更状态" className="mt-2 w-full" />
            </label>
            <label className="text-sm text-slate-600">
              本地最新卷
              <input value={form.localLatestVolume} onChange={(event) => setForm({ ...form, localLatestVolume: event.target.value })} type="number" step="0.01" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600">
              本地最新章/话
              <input value={form.localLatestChapter} onChange={(event) => setForm({ ...form, localLatestChapter: event.target.value })} type="number" step="0.01" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600">
              本地最新标题
              <input value={form.localLatestTitle} onChange={(event) => setForm({ ...form, localLatestTitle: event.target.value })} placeholder="例如 第 128 话 启航" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600">
              本地最新更新时间
              <input value={form.localLatestAt} onChange={(event) => setForm({ ...form, localLatestAt: event.target.value })} type="datetime-local" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600 md:col-span-2">
              标签
              <input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="标签，用逗号分隔" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600">
              系列名
              <input value={form.seriesName} onChange={(event) => setForm({ ...form, seriesName: event.target.value })} className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600">
              系列序号
              <input value={form.seriesIndex} onChange={(event) => setForm({ ...form, seriesIndex: event.target.value })} type="number" step="0.01" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600">
              出版年
              <input value={form.publishedYear} onChange={(event) => setForm({ ...form, publishedYear: event.target.value })} type="number" min="1000" max="3000" className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
            </label>
            <label className="text-sm text-slate-600 md:col-span-2">
              自定义封面
              <span className="mt-2 inline-flex h-11 cursor-pointer items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100">
                <UploadCloud size={16} />
                上传 JPG / PNG / WebP
                <input type="file" accept="image/jpeg,image/png,image/webp" disabled={saving} className="hidden" onChange={(event) => void uploadCover(event.target.files?.[0] ?? null)} />
              </span>
            </label>
            <label className="text-sm text-slate-600 md:col-span-2">
              简介
              <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={5} className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-slate-900 outline-none focus:border-blue-300" />
            </label>
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setEditing(false)}>取消</Button>
            <Button loading={busyAction === 'saveMetadata'} loadingText="保存中" disabled={saving && busyAction !== 'saveMetadata'} icon={Save} onClick={saveMetadata}>保存信息</Button>
          </div>
        </div>
      ) : null}
      <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">版本列表</h2>
          <span className="text-sm text-slate-500">{book.versionCount} 个版本 · {book.volumeCount} 个卷册</span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {book.editions.map((edition) => (
            <div key={edition.id} className={cn('rounded-2xl border p-4', edition.id === book.primaryEditionId ? 'border-blue-200 bg-blue-50/60' : 'border-slate-200 bg-white')}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-slate-900">{edition.versionName}</div>
                  <div className="mt-1 text-xs text-slate-500">{edition.format} · {edition.size} · {edition.formatValue === 'COMIC' ? `${edition.volumes.length} 卷` : `${edition.chapterCount ?? 0} 章`}</div>
                </div>
                {edition.primary ? <Badge tone="blue">主版本</Badge> : null}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => router.push(`/reader/${edition.id}${edition.volumes[0] ? `?volume=${encodeURIComponent(edition.volumes[0].id)}` : ''}`)}>阅读</Button>
                {!edition.primary ? <Button loading={busyAction === `primary:${edition.id}`} disabled={saving && busyAction !== `primary:${edition.id}`} variant="secondary" onClick={() => postAction(`/api/works/${book.id}/editions/${edition.id}/primary`, '已设为主版本', { refreshBook: true, busyKey: `primary:${edition.id}` })}>设为主版本</Button> : null}
                {book.editions.length > 1 ? <Button loading={busyAction === `split:${edition.id}`} disabled={saving && busyAction !== `split:${edition.id}`} variant="secondary" onClick={() => postAction(`/api/works/${book.id}/editions/${edition.id}/split`, '版本已拆出为新作品', { refreshBook: true, busyKey: `split:${edition.id}` })}>拆出作品</Button> : null}
              </div>
            </div>
          ))}
          {book.editions.length === 0 ? <div className="text-sm text-slate-500">暂无可用版本。</div> : null}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm lg:col-span-8">
            <h2 className="text-lg font-semibold">{book.type === 'comic' ? '卷册列表' : '章节列表'}</h2>
            <div className="mt-3 divide-y divide-slate-100">
              {book.type === 'comic' && comicSections.length > 0 ? comicSections.map((section) => (
              <button key={section.id} disabled={!readerEditionId} onClick={() => readerEditionId && router.push(`/reader/${readerEditionId}?volume=${encodeURIComponent(section.id)}`)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
                <img src={section.coverUrl} alt="" className="h-20 w-14 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{section.title}</div>
                  <div className="mt-1 text-xs text-slate-500">漫画 · {section.pageCount} 页</div>
                </div>
                <div className="flex gap-1" onClick={(event) => event.stopPropagation()}>
                  <Button loading={busyAction === `move:${section.id}:up`} disabled={saving && busyAction !== `move:${section.id}:up`} variant="ghost" className="min-h-8 px-2 py-1" onClick={() => moveVolume(section.id, 'up')}>上移</Button>
                  <Button loading={busyAction === `move:${section.id}:down`} disabled={saving && busyAction !== `move:${section.id}:down`} variant="ghost" className="min-h-8 px-2 py-1" onClick={() => moveVolume(section.id, 'down')}>下移</Button>
                </div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>
            )) : readingUnits.length > 0 ? readingUnits.slice(0, 80).map((unit) => (
              <button key={unit.id} disabled={!readerEditionId} onClick={() => readerEditionId && router.push(`/reader/${readerEditionId}`)} className="flex w-full items-center justify-between py-3 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
                <div>
                  <div className="font-medium">{unit.title}</div>
                  <div className="mt-1 text-xs text-slate-500">{unit.unitType === 'page' ? '漫画页' : '章节'} · {unit.mediaType ?? unit.href}</div>
                </div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>
            )) : (
              <button disabled={!readerEditionId} onClick={() => readerEditionId && router.push(`/reader/${readerEditionId}`)} className="flex w-full items-center justify-between py-4 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
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
      <MetadataLookupModal
        book={book}
        open={metadataLookupOpen}
        onClose={() => setMetadataLookupOpen(false)}
        onApplied={(nextBook) => {
          if (nextBook) setBook(nextBook);
          loadBook();
          setMessage('元数据已应用');
          toast.success('元数据已应用');
        }}
      />
      {dangerActionOpen ? (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/40 p-0 backdrop-blur-sm md:items-center md:p-6" role="dialog" aria-modal="true" aria-label="忽略或删除读物">
          <div className="w-full max-w-lg rounded-t-[28px] border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-950/20 md:rounded-[28px]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">忽略或删除读物</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">可以只隐藏《{book.title}》，也可以删除数据库记录。两种操作都不会删除源文件。</p>
              </div>
              <button type="button" onClick={() => setDangerActionOpen(false)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-slate-500 hover:bg-slate-100" aria-label="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setDangerActionOpen(false);
                  void setIgnored(true);
                }}
                className="rounded-2xl border border-amber-100 bg-amber-50 p-4 text-left text-sm text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="block font-semibold">仅忽略读物</span>
                <span className="mt-2 block leading-6 opacity-80">从书库和整理列表隐藏，稍后仍可恢复显示。</span>
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void deleteRecord(true)}
                className="rounded-2xl border border-red-100 bg-red-50 p-4 text-left text-sm text-red-800 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="block font-semibold">删除数据库记录</span>
                <span className="mt-2 block leading-6 opacity-80">移除这条读物记录，源文件保留在原位置。</span>
              </button>
            </div>
            <div className="mt-5 flex justify-end">
              <Button variant="secondary" onClick={() => setDangerActionOpen(false)}>取消</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
