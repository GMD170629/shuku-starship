import './globals.css';
import type { Metadata } from 'next';
import { AppShell } from '../components/layout/app-shell';

export const metadata: Metadata = {
  title: '书库星舰',
  description: 'NAS 自托管读物管理系统'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
