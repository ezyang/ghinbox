import type { Page } from '@playwright/test';
import {
  clearCacheStores,
  getNotificationsCache,
  setNotificationsCache,
} from './idb-utils';

export async function clearAppStorage(page: Page) {
  if (page.url() === 'about:blank') {
    return;
  }
  await clearCacheStores(page);
  await page.evaluate(() => localStorage.clear());
  // Clear server-side store (each worker has its own isolated DB)
  await page.request.delete('/api/store/all').catch(() => {});
  await page.reload();
}

export async function seedNotificationsCache(page: Page, notifications: unknown) {
  await setNotificationsCache(page, notifications);
}

export async function readNotificationsCache(page: Page) {
  return getNotificationsCache(page);
}

export async function seedCommentCache(page: Page, cache: unknown, repo = 'test/repo') {
  // Seed comment cache via server API (server is the source of truth)
  const [owner, repoName] = repo.split('/');
  const cacheObj = cache as { threads?: Record<string, unknown> };
  if (cacheObj?.threads) {
    for (const [threadKey, threadData] of Object.entries(cacheObj.threads)) {
      await page.request.put(
        `/api/store/comments/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/threads/${encodeURIComponent(threadKey)}`,
        { data: { data: threadData } }
      );
    }
  }
  // Set repo in localStorage so loadCommentCache can find it on init
  await page.evaluate((r) => {
    localStorage.setItem('ghnotif_repo', r);
  }, repo);
}

export async function readCommentCache(page: Page, repo = 'test/repo') {
  // Read comment cache via server API
  const [owner, repoName] = repo.split('/');
  const response = await page.request.get(
    `/api/store/comments/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`
  );
  const data = await response.json();
  const threads = data?.cache?.threads || {};
  return Object.keys(threads).length > 0 ? data.cache : null;
}
