export interface ScanTarget {
  path: string;
  recursive?: boolean;
}

export async function scanNas(_target: ScanTarget): Promise<void> {
  // TODO: 在这里实现 NAS 扫描逻辑
}
