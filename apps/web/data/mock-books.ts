export type BookFormat = 'PDF' | 'EPUB' | 'TXT' | 'MANGA' | 'DOC';

export interface MockBook {
  id: string;
  title: string;
  author: string;
  progress: number;
  format: BookFormat;
  updatedAt: string;
  gradient: string;
  shelf: string;
}

export const mockBooks: MockBook[] = [
  { id: '1', title: '深入理解 TypeScript', author: '陈明', progress: 42, format: 'PDF', updatedAt: '2026-05-20', gradient: 'from-slate-400 to-slate-600', shelf: '技术' },
  { id: '2', title: '系统设计入门', author: '李航', progress: 78, format: 'EPUB', updatedAt: '2026-05-24', gradient: 'from-zinc-400 to-zinc-600', shelf: '架构' },
  { id: '3', title: '产品方法论', author: '王楠', progress: 15, format: 'TXT', updatedAt: '2026-05-18', gradient: 'from-stone-400 to-stone-600', shelf: '产品' },
  { id: '4', title: '微服务实践手册', author: '周洋', progress: 63, format: 'DOC', updatedAt: '2026-05-22', gradient: 'from-gray-400 to-gray-600', shelf: '技术' }
];

export const scanLogs = [
  '[09:30:11] 开始扫描 /nas/books',
  '[09:30:24] 发现新增文件 12 个',
  '[09:31:01] 解析 metadata 完成',
  '[09:31:40] 任务运行中：封面缓存生成'
];
