'use client';

const DB_NAME = 'shuku-pwa-v0.3.1';
const DB_VERSION = 1;
const PROGRESS_STORE = 'progressQueue';
const PREFERENCE_STORE = 'preferenceQueue';

export type QueuedProgress = {
  bookId: string;
  progress: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  retryCount: number;
};

export type QueuedPreference = {
  type: string;
  settings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  retryCount: number;
};

type StoreName = typeof PROGRESS_STORE | typeof PREFERENCE_STORE;

function canUseIndexedDb() {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error('IndexedDB is not available'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROGRESS_STORE)) {
        db.createObjectStore(PROGRESS_STORE, { keyPath: 'bookId' });
      }
      if (!db.objectStoreNames.contains(PREFERENCE_STORE)) {
        db.createObjectStore(PREFERENCE_STORE, { keyPath: 'type' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function withStore<T>(storeName: StoreName, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void) {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = action(store);
    let result: T | undefined;

    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    }

    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    };
  });
}

function getAllFromStore<T>(storeName: StoreName) {
  return withStore<T[]>(storeName, 'readonly', (store) => store.getAll()).then((items) => items ?? []);
}

function putInStore<T>(storeName: StoreName, value: T) {
  return withStore<IDBValidKey>(storeName, 'readwrite', (store) => store.put(value));
}

function deleteFromStore(storeName: StoreName, key: IDBValidKey) {
  return withStore<undefined>(storeName, 'readwrite', (store) => {
    store.delete(key);
  });
}

function clearStore(storeName: StoreName) {
  return withStore<undefined>(storeName, 'readwrite', (store) => {
    store.clear();
  });
}

async function getProgressItem(bookId: string) {
  return withStore<QueuedProgress>(PROGRESS_STORE, 'readonly', (store) => store.get(bookId));
}

async function getPreferenceItem(type: string) {
  return withStore<QueuedPreference>(PREFERENCE_STORE, 'readonly', (store) => store.get(type));
}

export async function enqueueProgress(bookId: string, progressPayload: Record<string, unknown>) {
  if (!bookId) return;
  const now = Date.now();
  const existing = await getProgressItem(bookId).catch(() => undefined);
  await putInStore(PROGRESS_STORE, {
    bookId,
    progress: progressPayload,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    retryCount: existing?.retryCount ?? 0
  } satisfies QueuedProgress).catch(() => undefined);
}

export async function getQueuedProgress(bookId?: string) {
  if (bookId) {
    const item = await getProgressItem(bookId).catch(() => undefined);
    return item ? [item] : [];
  }
  return getAllFromStore<QueuedProgress>(PROGRESS_STORE).catch(() => []);
}

export async function flushProgressQueue(syncFn?: (item: QueuedProgress) => Promise<void>) {
  const items = await getQueuedProgress();
  for (const item of items.sort((left, right) => left.updatedAt - right.updatedAt)) {
    try {
      if (syncFn) {
        await syncFn(item);
      } else {
        const response = await fetch(`/api/editions/${encodeURIComponent(item.bookId)}/progress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.progress)
        });
        if (!response.ok) throw new Error('Progress sync failed');
      }
      await deleteFromStore(PROGRESS_STORE, item.bookId);
    } catch {
      await putInStore(PROGRESS_STORE, { ...item, retryCount: item.retryCount + 1, updatedAt: Date.now() }).catch(() => undefined);
    }
  }
}

export async function enqueuePreference(type: string, settings: Record<string, unknown>) {
  if (!type) return;
  const now = Date.now();
  const existing = await getPreferenceItem(type).catch(() => undefined);
  await putInStore(PREFERENCE_STORE, {
    type,
    settings,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    retryCount: existing?.retryCount ?? 0
  } satisfies QueuedPreference).catch(() => undefined);
}

export async function flushPreferenceQueue(syncFn?: (item: QueuedPreference) => Promise<void>) {
  const items = await getAllFromStore<QueuedPreference>(PREFERENCE_STORE).catch(() => []);
  for (const item of items.sort((left, right) => left.updatedAt - right.updatedAt)) {
    try {
      if (syncFn) {
        await syncFn(item);
      } else {
        const response = await fetch(`/api/reader/preferences/${encodeURIComponent(item.type)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: item.settings })
        });
        if (!response.ok) throw new Error('Preference sync failed');
      }
      await deleteFromStore(PREFERENCE_STORE, item.type);
    } catch {
      await putInStore(PREFERENCE_STORE, { ...item, retryCount: item.retryCount + 1, updatedAt: Date.now() }).catch(() => undefined);
    }
  }
}

export async function flushOfflineQueues() {
  await flushProgressQueue();
  await flushPreferenceQueue();
}

export async function clearProgressQueue() {
  await Promise.all([clearStore(PROGRESS_STORE), clearStore(PREFERENCE_STORE)]).catch(() => undefined);
}

export async function clearPrivatePwaData() {
  await clearProgressQueue();
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.includes('private') || key.includes('cover') || key.includes('api'))
        .map((key) => caches.delete(key))
    );
  }
  if ('serviceWorker' in navigator) {
    const controller = navigator.serviceWorker.controller;
    controller?.postMessage({ type: 'CLEAR_PRIVATE_CACHES' });
  }
}
