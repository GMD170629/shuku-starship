'use client';

import { AlertCircle, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Database, Download, Edit3, EyeOff, MoveRight, RefreshCw, Save, Search, Trash2, UploadCloud, X } from 'lucide-react';
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
  { value: 'EPUB', label: 'EPUB' },
  { value: 'PDF', label: 'PDF' }
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

const DEFAULT_DESCRIPTION = '暂无简介，可在详情页补充元数据。';

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
type VolumeSectionView = { id: string; editionId?: string | null; title: string; index: number; fileId: string; pageCount: number; coverUrl: string };
type WorksResponse = { ok: boolean; data?: { books: WorkView[] }; error?: { message: string } };

function readerUrlForBook(book: WorkView, volumeSections: VolumeSectionView[]) {
  const editionId = readableEditionId(book);
  if (!editionId) return null;
  const volumeId = book.recentVolumeId ?? volumeSections[0]?.id ?? null;
  return volumeId ? `/reader/${editionId}?volume=${encodeURIComponent(volumeId)}` : `/reader/${editionId}`;
}

function compactEditionLabel(book: WorkView) {
  const primaryEdition = book.editions.find((edition) => edition.id === book.primaryEditionId) ?? book.editions.find((edition) => !edition.hidden) ?? book.editions[0];
  if (!primaryEdition) return `${book.format} · ${book.size}`;
  const unitLabel = primaryEdition.formatValue === 'COMIC' ? `${primaryEdition.volumes.length || book.volumeCount} 卷` : `${primaryEdition.chapterCount ?? book.chapterCount ?? book.totalUnits ?? 0} 章`;
  return `${primaryEdition.format} · ${primaryEdition.size} · ${unitLabel} · ${primaryEdition.primary ? '主版本' : '可读版本'}`;
}

function metadataMissingLabels(book: WorkView, metadata: DetailMetadata | null) {
  const missing: string[] = [];
  if (!book.author || book.author === '未知作者') missing.push('作者');
  if (!book.seriesName) missing.push('系列');
  if (!book.publishedYear) missing.push('出版年');
  if (!book.tags.length) missing.push('标签');
  return missing;
}

function qualityLabel(score: number) {
  if (score >= 80) return { label: '完整', tone: 'green' as const };
  if (score >= 50) return { label: '可用', tone: 'amber' as const };
  return { label: '待整理', tone: 'red' as const };
}

export function BookDetailPage({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [book, setBook] = useState<WorkView | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [metadata, setMetadata] = useState<DetailMetadata | null>(null);
  const [readingUnits, setReadingUnits] = useState<ReadingUnitView[]>([]);
  const [volumeSections, setVolumeSections] = useState<VolumeSectionView[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [metadataLookupOpen, setMetadataLookupOpen] = useState(false);
  const [dangerActionOpen, setDangerActionOpen] = useState(false);
  const [moveTargetOpen, setMoveTargetOpen] = useState(false);
  const [movingVolume, setMovingVolume] = useState<VolumeSectionView | null>(null);
  const [targetSearch, setTargetSearch] = useState('');
  const [targetBooks, setTargetBooks] = useState<WorkView[]>([]);
  const [targetBooksLoading, setTargetBooksLoading] = useState(false);
  const [targetBookId, setTargetBookId] = useState('');
  const [targetEditionId, setTargetEditionId] = useState('');
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
    return fetch(`/api/works/${bookId}`)
      .then((response) => response.json() as Promise<{ ok: boolean; data?: { book: WorkView; metadata?: DetailMetadata; readingUnits?: ReadingUnitView[]; volumeSections?: VolumeSectionView[] }; error?: { message: string } }>)
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取读物失败');
        const nextBook = payload.data?.book ?? null;
        setBook(nextBook);
        setMetadata(payload.data?.metadata ?? null);
        setReadingUnits(payload.data?.readingUnits ?? []);
        setVolumeSections(payload.data?.volumeSections ?? []);
        if (nextBook) {
          setForm({
            title: nextBook.title,
            author: nextBook.author === '未知作者' ? '' : nextBook.author,
            description: nextBook.desc === DEFAULT_DESCRIPTION ? '' : nextBook.desc,
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

  useEffect(() => {
    if (!moveTargetOpen) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setTargetBooksLoading(true);
      const params = new URLSearchParams({ visibility: 'active', pageSize: '12', page: '1' });
      if (targetSearch.trim()) params.set('search', targetSearch.trim());
      fetch(`/api/works?${params.toString()}`)
        .then((response) => response.json() as Promise<WorksResponse>)
        .then((payload) => {
          if (!active) return;
          if (!payload.ok) throw new Error(payload.error?.message ?? '搜索目标读物失败');
          setTargetBooks((payload.data?.books ?? []).filter((item) => item.id !== bookId));
        })
        .catch((reason) => {
          if (!active) return;
          setTargetBooks([]);
          toast.error('搜索目标读物失败', reason instanceof Error ? reason.message : '请稍后重试');
        })
        .finally(() => active && setTargetBooksLoading(false));
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [bookId, moveTargetOpen, targetSearch, toast]);

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
      if (options.refreshBook) await loadBook();
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

  function openMoveTarget(volume: VolumeSectionView) {
    setMovingVolume(volume);
    setMoveTargetOpen(true);
    setTargetSearch('');
    setTargetBooks([]);
    setTargetBookId('');
    setTargetEditionId('');
  }

  async function moveVolumeToTarget() {
    if (!movingVolume || !targetEditionId) return;
    setSaving(true);
    setBusyAction(`move-to:${movingVolume.id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/works/${bookId}/volumes/${movingVolume.id}/move-to`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetEditionId })
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '移动卷册失败');
      setMoveTargetOpen(false);
      setMovingVolume(null);
      await loadBook();
      setMessage('卷册已移动到目标版本');
      toast.success('卷册已移动到目标版本');
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '移动卷册失败';
      setError(nextError);
      toast.error('移动卷册失败', nextError);
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
  if (!book || !displayBook) return <div className="shuku-loading-panel p-8 text-sm" role="status" aria-live="polite">正在读取读物详情...</div>;
  const readerEditionId = readableEditionId(book);
  const hasVolumeSections = volumeSections.length > 0;
  const readerUrl = readerUrlForBook(book, volumeSections);
  const missingMetadata = metadataMissingLabels(book, metadata);
  const quality = qualityLabel(book.metadataQuality);
  const visibleReadingUnits = readingUnits.slice(0, 120);
  const navigationTitle = hasVolumeSections ? '卷册' : '章节';
  const navigationSummary = hasVolumeSections ? `${volumeSections.length} 个卷册` : readingUnits.length > 0 ? `${readingUnits.length} 章` : '未解析章节';
  const hasDescription = Boolean(book.desc && book.desc !== DEFAULT_DESCRIPTION);
  const movingVolumeRecord = movingVolume ? book.volumes.find((volume) => volume.id === movingVolume.id) : null;
  const movingEdition = movingVolumeRecord ? book.editions.find((edition) => edition.id === movingVolumeRecord.editionId) : null;
  const movingFormat = movingEdition?.formatValue ?? book.formatValue;
  const selectedTargetBook = targetBooks.find((item) => item.id === targetBookId) ?? null;
  const targetEditionOptions = selectedTargetBook?.editions ?? [];
  const selectedTargetEdition = targetEditionOptions.find((edition) => edition.id === targetEditionId) ?? null;

  return (
    <div className="space-y-5">
      <button onClick={() => router.push('/library')} className="flex items-center gap-2 text-sm text-slate-500 transition hover:text-slate-900">
        <ChevronLeft size={16} /> 返回书库
      </button>
      {error ? <div className="rounded-3xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[132px_minmax(0,1fr)_320px]">
          <Cover book={displayBook} className="aspect-[2/3] w-28 shrink-0 sm:w-32 xl:w-full" size="large" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={quality.tone}>{quality.label}</Badge>
              <Badge tone={book.lastReadAt ? 'green' : 'slate'}>{book.lastReadAt ? '有进度' : '未阅读'}</Badge>
              {book.ignored ? <Badge tone="amber">已忽略</Badge> : null}
              {book.trackingStatusValue === 'TRACKING' ? <Badge tone="green">追更中</Badge> : null}
              {book.publicationStatusValue !== 'UNKNOWN' ? <Badge tone={book.publicationStatusValue === 'ONGOING' ? 'green' : 'slate'}>{book.publicationStatus}</Badge> : null}
            </div>
            <h1 className="mt-2 line-clamp-2 text-2xl font-semibold tracking-tight text-slate-950">《{book.title}》</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
              <span>{book.author}</span>
              {book.seriesName ? <span>{book.seriesName}{book.seriesIndex !== null ? ` · ${book.seriesIndex}` : ''}</span> : null}
              <span>{compactEditionLabel(book)}</span>
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
              <div className="rounded-2xl bg-slate-50 px-4 py-3">
                <div className="text-xs font-medium text-slate-500">阅读进度</div>
                <div className="mt-1 truncate text-sm font-semibold text-slate-950">{book.progress}% · {book.chapter}</div>
                <Progress value={book.progress} className="mt-2" />
              </div>
              <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-slate-100 bg-white text-sm">
                <div className="border-r border-slate-100 px-3 py-2">
                  <div className="text-xs text-slate-400">{book.type === 'comic' ? '页数' : '章节'}</div>
                  <div className="mt-1 font-semibold text-slate-950">{book.totalUnits || '未知'}</div>
                </div>
                <div className="px-3 py-2">
                  <div className="text-xs text-slate-400">大小</div>
                  <div className="mt-1 font-semibold text-slate-950">{book.size}</div>
                </div>
              </div>
            </div>
            <section className="mt-4 rounded-2xl bg-slate-50 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-950">简介</h2>
              <p className={cn('mt-2 whitespace-pre-line text-sm leading-6', hasDescription ? 'line-clamp-5 text-slate-700' : 'text-slate-400')}>
                {hasDescription ? book.desc : '暂无简介'}
              </p>
            </section>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button disabled={!readerEditionId || !readerUrl} icon={BookOpen} onClick={() => readerUrl && router.push(readerUrl)}>{book.progress > 0 ? '继续阅读' : '开始阅读'}</Button>
              <Button variant="secondary" icon={Edit3} onClick={() => setEditing((value) => !value)}>{editing ? '收起编辑' : '编辑信息'}</Button>
              <Button disabled={saving} variant="secondary" icon={Database} onClick={() => setMetadataLookupOpen(true)}>元数据识别</Button>
              <Button disabled={!readerEditionId} variant="ghost" icon={Download} onClick={downloadPrimaryEdition}>下载</Button>
              <Button loading={busyAction === 'regenerateCover'} disabled={saving && busyAction !== 'regenerateCover'} variant="ghost" icon={RefreshCw} onClick={() => postAction(`/api/works/${book.id}/cover/regenerate`, '封面已重新生成', { refreshCover: true, refreshBook: true, busyKey: 'regenerateCover' })}>重生成封面</Button>
              {book.ignored ? (
                <Button loading={busyAction === 'ignored'} disabled={saving && busyAction !== 'ignored'} variant="secondary" icon={EyeOff} onClick={() => setIgnored(false)}>恢复显示</Button>
              ) : (
                <Button loading={busyAction === 'ignored' || busyAction === 'delete'} loadingText={busyAction === 'delete' ? '删除中' : '处理中'} disabled={saving && !['ignored', 'delete'].includes(busyAction)} variant="danger" icon={Trash2} onClick={() => setDangerActionOpen(true)}>忽略/删除</Button>
              )}
            </div>
            {message ? <div className="mt-3 text-sm text-emerald-600">{message}</div> : null}
          </div>
          <aside className="rounded-2xl bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold text-slate-950">管理诊断</h2>
              <Badge tone={missingMetadata.length ? 'amber' : 'green'}>{missingMetadata.length ? `缺 ${missingMetadata.length} 项` : '已整理'}</Badge>
            </div>
            <div className="mt-3 grid gap-2 text-sm">
              <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2">
                <span className="text-slate-500">{navigationTitle}</span>
                <span className="font-medium text-slate-950">{navigationSummary}</span>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2">
                <span className="text-slate-500">版本</span>
                <span className="font-medium text-slate-950">{book.versionCount} 版 · {book.volumeCount} 卷</span>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2">
                <span className="text-slate-500">最后阅读</span>
                <span className="max-w-[150px] truncate font-medium text-slate-950">{book.lastRead}</span>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2">
                <span className="text-slate-500">本地最新</span>
                <span className="max-w-[150px] truncate font-medium text-slate-950">{localLatestLabel(book)}</span>
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <div className="flex items-center gap-2 font-medium">
                <AlertCircle size={15} />
                {missingMetadata.length ? '建议补全元数据' : '元数据没有明显缺口'}
              </div>
              <div className="mt-1 line-clamp-2 text-xs leading-5 opacity-80">{missingMetadata.length ? missingMetadata.join('、') : '可以继续检查章节顺序和版本。'}</div>
            </div>
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
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">{navigationTitle}</h2>
              <p className="mt-1 text-sm text-slate-500">{navigationSummary}</p>
            </div>
          </div>
          <div className="mt-4">
            {hasVolumeSections ? (
              <div className="flex flex-wrap gap-3">
                {volumeSections.map((volume, index) => (
                  <div key={volume.id} className="group relative w-36 rounded-2xl border border-slate-100 bg-white p-2 shadow-sm transition hover:border-blue-100 hover:shadow-md">
                    <button disabled={!readerEditionId} onClick={() => readerEditionId && router.push(`/reader/${readerEditionId}?volume=${encodeURIComponent(volume.id)}`)} className="block w-full text-left disabled:cursor-not-allowed disabled:opacity-50">
                      <span className="absolute left-3 top-3 rounded-full bg-white/90 px-2 py-0.5 text-xs tabular-nums text-slate-500 shadow-sm">{String(index + 1).padStart(2, '0')}</span>
                      <img src={volume.coverUrl} alt={`${volume.title} 封面`} className="aspect-[2/3] w-full rounded-xl object-cover bg-slate-100" />
                      <span className="mt-2 block line-clamp-2 min-h-10 text-sm font-medium leading-5 text-slate-950">{volume.title}</span>
                    </button>
                    <div className="absolute right-3 top-3 flex overflow-hidden rounded-full border border-slate-100 bg-white/95 opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-within:opacity-100">
                      <button type="button" disabled={saving && busyAction !== `move:${volume.id}:up`} onClick={() => moveVolume(volume.id, 'up')} className="flex h-8 w-8 items-center justify-center text-slate-500 transition hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50" aria-label={`前移 ${volume.title}`}>
                        <ChevronLeft size={15} />
                      </button>
                      <button type="button" disabled={saving && busyAction !== `move:${volume.id}:down`} onClick={() => moveVolume(volume.id, 'down')} className="flex h-8 w-8 items-center justify-center border-l border-slate-100 text-slate-500 transition hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50" aria-label={`后移 ${volume.title}`}>
                        <ChevronRight size={15} />
                      </button>
                      <button type="button" disabled={saving} onClick={() => openMoveTarget(volume)} className="flex h-8 w-8 items-center justify-center border-l border-slate-100 text-slate-500 transition hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50" aria-label={`移动 ${volume.title} 到其他读物`}>
                        <MoveRight size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : readingUnits.length > 0 ? (
              <div className="flex flex-wrap gap-3">
                {visibleReadingUnits.map((unit, index) => (
                  <button key={unit.id} disabled={!readerEditionId} onClick={() => readerEditionId && router.push(`/reader/${readerEditionId}`)} className="min-h-24 w-full rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm transition hover:border-blue-100 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 sm:w-56">
                    <span className="text-xs tabular-nums text-slate-400">{String(index + 1).padStart(3, '0')}</span>
                    <span className="mt-2 line-clamp-3 text-sm font-medium leading-5 text-slate-950">{unit.title}</span>
                  </button>
                ))}
              </div>
            ) : (
              <button disabled={!readerEditionId} onClick={() => readerEditionId && router.push(`/reader/${readerEditionId}`)} className="flex w-full items-center justify-between rounded-2xl border border-slate-100 bg-white px-4 py-4 text-left transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
                <div className="text-sm text-slate-500">未拿到章节明细</div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>
            )}
          </div>
          {readingUnits.length > visibleReadingUnits.length ? <div className="px-1 py-4 text-sm text-slate-500">还有 {readingUnits.length - visibleReadingUnits.length} 项未展开，进入阅读器可继续阅读。</div> : null}
        </section>

        <aside className="space-y-4">
          <section className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-950">版本与文件</h2>
              <span className="text-sm text-slate-500">{book.versionCount} 版 · {book.volumeCount} 卷</span>
            </div>
            <div className="mt-3 space-y-2">
              {book.editions.map((edition) => (
                <div key={edition.id} className={cn('rounded-2xl border p-3', edition.id === book.primaryEditionId ? 'border-blue-200 bg-blue-50/70' : 'border-slate-100 bg-slate-50/70')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-950">{edition.versionName}</div>
                      <div className="mt-1 text-xs text-slate-500">{edition.formatValue === 'COMIC' ? `${edition.volumes.length} 卷` : `${edition.chapterCount ?? 0} 章`}</div>
                    </div>
                    {edition.primary ? <Badge tone="blue">主版本</Badge> : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="secondary" className="min-h-8 px-3 py-1.5" onClick={() => router.push(`/reader/${edition.id}${edition.volumes[0] ? `?volume=${encodeURIComponent(edition.volumes[0].id)}` : ''}`)}>阅读</Button>
                    {!edition.primary ? <Button loading={busyAction === `primary:${edition.id}`} disabled={saving && busyAction !== `primary:${edition.id}`} variant="ghost" className="min-h-8 px-3 py-1.5" onClick={() => postAction(`/api/works/${book.id}/editions/${edition.id}/primary`, '已设为主版本', { refreshBook: true, busyKey: `primary:${edition.id}` })}>设为主版本</Button> : null}
                    {book.editions.length > 1 ? <Button loading={busyAction === `split:${edition.id}`} disabled={saving && busyAction !== `split:${edition.id}`} variant="ghost" className="min-h-8 px-3 py-1.5" onClick={() => postAction(`/api/works/${book.id}/editions/${edition.id}/split`, '版本已拆出为新作品', { refreshBook: true, busyKey: `split:${edition.id}` })}>拆出</Button> : null}
                  </div>
                </div>
              ))}
              {book.editions.length === 0 ? <div className="text-sm text-slate-500">暂无可用版本。</div> : null}
            </div>
          </section>

          <section className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">更多信息</h2>
            <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">阅读状态</div>
                <div className="mt-1 font-medium text-slate-950">{book.status}</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">追更状态</div>
                <div className="mt-1 font-medium text-slate-950">{book.trackingStatus}</div>
              </div>
            </div>
            <Info label="标签" value={book.tags.join(', ') || '无'} />
            <details className="group mt-4 rounded-2xl bg-slate-50">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-3 text-sm font-medium text-slate-700">
                出版信息
                <ChevronDown size={16} className="text-slate-400 transition group-open:rotate-180" />
              </summary>
              <div className="border-t border-slate-100 px-3 pb-3">
                {book.type === 'ebook' ? (
                  <>
                    <Info label="ISBN" value={metadata?.isbn ?? '未知'} />
                    <Info label="出版社" value={metadata?.publisher ?? '未知'} />
                    <Info label="语言" value={metadata?.language ?? '未知'} />
                    <Info label="出版年" value={book.publishedYear === null ? '未知' : String(book.publishedYear)} />
                  </>
                ) : (
                  <>
                    <Info label="系列" value={String((metadata?.items?.[0]?.metadataJson as any)?.comicInfo?.Series ?? (metadata?.items?.[0]?.metadataJson as any)?.comicInfo?.series ?? '未知')} />
                    <Info label="卷数" value={String((metadata?.items?.[0]?.metadataJson as any)?.comicInfo?.Volume ?? (metadata?.items?.[0]?.metadataJson as any)?.comicInfo?.volume ?? '未知')} />
                    <Info label="页数" value={`${book.totalUnits || '未知'}`} />
                  </>
                )}
              </div>
            </details>
            <details className="group mt-4 rounded-2xl bg-slate-50">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-3 text-sm font-medium text-slate-700">
                文件信息
                <ChevronDown size={16} className="text-slate-400 transition group-open:rotate-180" />
              </summary>
              <div className="border-t border-slate-100 px-3 pb-3">
                <Info label="源路径" value={book.path} />
                <Info label="文件哈希" value={book.fileHash} />
                <Info label="资源数量" value={`${book.files.length} 个文件`} />
                <Info label="添加时间" value={book.added} />
                <Info label="最新时间" value={formatDateTime(book.localLatestAt)} />
              </div>
            </details>
          </section>
        </aside>
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
      {moveTargetOpen && movingVolume ? (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/40 p-0 backdrop-blur-sm md:items-center md:p-6" role="dialog" aria-modal="true" aria-label="移动卷册">
          <div className="w-full max-w-2xl rounded-t-[28px] border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-950/20 md:rounded-[28px]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">移动卷册</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">将「{movingVolume.title}」移动到另一读物的同格式版本下，移动后目标版本会按卷号重排。</p>
              </div>
              <button type="button" onClick={() => setMoveTargetOpen(false)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-slate-500 hover:bg-slate-100" aria-label="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <section>
                <label className="text-sm font-medium text-slate-700">目标读物</label>
                <div className="mt-2 flex h-11 items-center gap-2 rounded-2xl border border-slate-200 px-3">
                  <Search size={16} className="text-slate-400" />
                  <input value={targetSearch} onChange={(event) => setTargetSearch(event.target.value)} placeholder="搜索标题、作者、标签" className="w-full bg-transparent text-sm outline-none" />
                </div>
                <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">
                  {targetBooks.map((targetBook) => (
                    <button
                      key={targetBook.id}
                      type="button"
                      onClick={() => {
                        setTargetBookId(targetBook.id);
                        setTargetEditionId('');
                      }}
                      className={cn('w-full rounded-2xl border p-3 text-left transition', targetBook.id === targetBookId ? 'border-blue-200 bg-blue-50' : 'border-slate-100 bg-slate-50 hover:bg-slate-100')}
                    >
                      <span className="block truncate text-sm font-medium text-slate-950">《{targetBook.title}》</span>
                      <span className="mt-1 block truncate text-xs text-slate-500">{targetBook.author} · {targetBook.versionCount} 版 · {targetBook.volumeCount} 卷</span>
                    </button>
                  ))}
                  {targetBooksLoading ? <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">正在搜索...</div> : null}
                  {!targetBooksLoading && targetBooks.length === 0 ? <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">没有找到可选目标读物。</div> : null}
                </div>
              </section>
              <section>
                <div className="text-sm font-medium text-slate-700">目标版本</div>
                <div className="mt-2 rounded-2xl bg-slate-50 p-3 text-xs leading-5 text-slate-500">
                  源格式：{movingEdition?.format ?? book.format}。只能移动到相同格式版本，卷号缺失或重复也允许移动。
                </div>
                <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">
                  {targetEditionOptions.map((edition) => {
                    const compatible = edition.formatValue === movingFormat;
                    return (
                      <button
                        key={edition.id}
                        type="button"
                        disabled={!compatible}
                        onClick={() => setTargetEditionId(edition.id)}
                        className={cn('w-full rounded-2xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-45', edition.id === targetEditionId ? 'border-blue-200 bg-blue-50' : 'border-slate-100 bg-white hover:bg-slate-50')}
                      >
                        <span className="block truncate text-sm font-medium text-slate-950">{edition.versionName}</span>
                        <span className="mt-1 block text-xs text-slate-500">{edition.format} · {edition.volumes.length} 卷{compatible ? '' : ' · 格式不一致'}</span>
                      </button>
                    );
                  })}
                  {selectedTargetBook && targetEditionOptions.length === 0 ? <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">目标读物暂无可用版本。</div> : null}
                  {!selectedTargetBook ? <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">先选择一本目标读物。</div> : null}
                </div>
              </section>
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-slate-500">{selectedTargetEdition ? `将移动到「${selectedTargetEdition.versionName}」` : '请选择目标读物和版本'}</div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setMoveTargetOpen(false)}>取消</Button>
                <Button loading={busyAction === `move-to:${movingVolume.id}`} loadingText="移动中" disabled={!targetEditionId || saving} icon={MoveRight} onClick={() => void moveVolumeToTarget()}>确认移动</Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
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
