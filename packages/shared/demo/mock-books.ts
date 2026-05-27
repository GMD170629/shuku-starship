export type Book = {
  id: string;
  title: string;
  author: string;
  type: string;
  format: string;
  gradient: string;
  tags: string[];
  progress: number;
  status: '想看' | '在读' | '已读';
  chapter: string;
  desc: string;
};

export const books: Book[] = [
  {
    id: 'mock-starship-library',
    title: '星屑魔女与机械书库',
    author: 'Shuku Lab',
    type: '漫画',
    format: '漫画',
    gradient: 'from-blue-600 via-cyan-500 to-emerald-400',
    tags: ['科幻', '漫画', '收藏'],
    progress: 68,
    status: '在读',
    chapter: '第 12 话',
    desc: '一套用于展示移动端和首页状态的示例读物，模拟跨设备阅读进度、标签和章节信息。'
  },
  {
    id: 'mock-nas-manual',
    title: 'NAS 书库维护手册',
    author: 'Archive Ops',
    type: '资料',
    format: 'PDF',
    gradient: 'from-slate-700 via-indigo-500 to-sky-400',
    tags: ['NAS', '技术资料'],
    progress: 34,
    status: '在读',
    chapter: '文件索引',
    desc: '关于目录扫描、文件权限和备份策略的维护笔记。'
  },
  {
    id: 'mock-reading-notes',
    title: '阅读笔记合集',
    author: 'Gu',
    type: '小说',
    format: 'TXT',
    gradient: 'from-rose-500 via-orange-400 to-amber-300',
    tags: ['笔记', '小说'],
    progress: 100,
    status: '已读',
    chapter: '尾声',
    desc: '同步测试用的纯文本读物。'
  },
  {
    id: 'mock-cover-guide',
    title: '封面索引指南',
    author: 'Scanner Team',
    type: '资料',
    format: 'PDF',
    gradient: 'from-emerald-600 via-teal-500 to-lime-300',
    tags: ['封面', '索引'],
    progress: 12,
    status: '想看',
    chapter: '准备阅读',
    desc: '展示封面生成和缓存状态的示例资料。'
  }
];

export const shelves = [
  { name: '正在阅读', ids: ['mock-starship-library', 'mock-nas-manual'], count: 2, updated: '今天' },
  { name: '技术资料', ids: ['mock-nas-manual', 'mock-cover-guide'], count: 18, updated: '昨天' },
  { name: '已完成', ids: ['mock-reading-notes'], count: 7, updated: '本周' },
  { name: '收藏漫画', ids: ['mock-starship-library'], count: 24, updated: '本月' }
];
