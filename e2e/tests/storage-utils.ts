import type { Page } from '@playwright/test';
import {
  clearCacheStores,
  getCommentCache,
  getNotificationsCache,
  setCommentCache,
  setNotificationsCache,
} from './idb-utils';

export const APP_STORAGE_KEYS = {
  autoMarkTrash: 'ghnotif_auto_mark_trash_done',
  authCache: 'ghnotif_auth_cache',
  lastSyncedRepo: 'ghnotif_last_synced_repo',
  repo: 'ghnotif_repo',
} as const;

export async function clearAppStorage(page: Page) {
  if (page.url() === 'about:blank') {
    return;
  }
  await clearCacheStores(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

export async function addAuthCacheInitScript(page: Page, login: string | null = 'testuser') {
  await page.addInitScript(
    ({ key, loginValue }) => {
      localStorage.setItem(
        key,
        JSON.stringify({ login: loginValue, timestamp: Date.now() })
      );
    },
    { key: APP_STORAGE_KEYS.authCache, loginValue: login }
  );
}

export async function seedAuthCache(page: Page, login: string | null = 'testuser') {
  await page.evaluate(
    ({ key, loginValue }) => {
      localStorage.setItem(
        key,
        JSON.stringify({ login: loginValue, timestamp: Date.now() })
      );
    },
    { key: APP_STORAGE_KEYS.authCache, loginValue: login }
  );
}

export async function seedRepoSelection(
  page: Page,
  repo: string,
  options: { lastSynced?: boolean } = {}
) {
  await page.evaluate(
    ({ keys, repoValue, lastSynced }) => {
      localStorage.setItem(keys.repo, repoValue);
      if (lastSynced) {
        localStorage.setItem(keys.lastSyncedRepo, repoValue);
      }
    },
    { keys: APP_STORAGE_KEYS, repoValue: repo, lastSynced: options.lastSynced ?? false }
  );
}

export async function seedNotificationsCache(page: Page, notifications: unknown) {
  await setNotificationsCache(page, notifications);
}

export async function readNotificationsCache(page: Page) {
  return getNotificationsCache(page);
}

export async function seedCommentCache(page: Page, cache: unknown) {
  await setCommentCache(page, cache);
}

export async function readCommentCache(page: Page) {
  return getCommentCache(page);
}
