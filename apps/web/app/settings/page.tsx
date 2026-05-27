import { AppShell } from '@/components/layout/app-shell';
import { SettingSwitch } from '@/components/ui/setting-switch';

export default function SettingsPage(){return <AppShell title="设置"><div className="space-y-3"><SettingSwitch label="自动扫描" defaultOn /><SettingSwitch label="阅读进度同步" defaultOn /><SettingSwitch label="启动时预加载封面" /></div></AppShell>;}
