export type ReaderItemKind = 'comic' | 'novel' | 'pdf' | 'epub' | 'txt' | 'gallery' | 'doc';

export interface HealthResponse {
  status: 'ok' | 'error';
  service: string;
}
