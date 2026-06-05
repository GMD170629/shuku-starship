import type { SourceProvider } from './source-provider';
import { httpSourceProvider } from './providers/http-source-provider';
import { manualSourceProvider } from './providers/manual-source-provider';
import { ptRssProvider } from './providers/pt-rss-provider';

const providers = new Map<string, SourceProvider>();

export function registerSourceProvider(provider: SourceProvider) {
  providers.set(provider.providerType, provider);
}

export function getSourceProvider(providerType: string): SourceProvider {
  const provider = providers.get(providerType);
  if (!provider) throw new Error(`源类型 ${providerType} 尚未实现 Provider。`);
  return provider;
}

registerSourceProvider(manualSourceProvider);
registerSourceProvider(ptRssProvider);
registerSourceProvider(httpSourceProvider);
