import type { Page } from '@playwright/test';
import {
  clearCacheStores,
  getCommentCache,
  getNotificationsCache,
  setCommentCache,
  setNotificationsCache,
} from './idb-utils';

export async function clearAppStorage(page: Page) {
  if (page.url() === 'about:blank') {
    return;
  }
  await clearCacheStores(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
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
