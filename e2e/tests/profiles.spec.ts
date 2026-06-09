import { test, expect } from '@playwright/test';
import { mockDefaultApiRoutes } from './app-fixture';
import { clearAppStorage } from './storage-utils';

function notification(id: string, repo: string, title: string, number: number) {
  const [owner, name] = repo.split('/');
  return {
    id,
    unread: true,
    reason: 'mention',
    updated_at: `2025-01-0${number}T12:00:00Z`,
    repository: { owner, name, full_name: repo },
    subject: {
      title,
      url: `https://github.com/${repo}/issues/${number}`,
      type: 'Issue',
      number,
      state: 'open',
      state_reason: null,
    },
    actors: [],
    ui: { saved: false, done: false },
  };
}

function response(repo: string, notifications: unknown[]) {
  const [owner, name] = repo.split('/');
  return {
    source_url: `https://github.com/notifications?query=repo:${repo}`,
    generated_at: '2025-01-01T00:00:00Z',
    repository: { owner, name, full_name: repo },
    notifications,
    pagination: {
      before_cursor: null,
      after_cursor: null,
      has_previous: false,
      has_next: false,
    },
    authenticity_token: 'token',
  };
}

test.describe('Notification Profiles @smoke', () => {
  test.beforeEach(async ({ page }) => {
    await mockDefaultApiRoutes(page);
    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('ships pytorch and everything-else profile defaults', async ({ page }) => {
    await expect(page.locator('#profile-select')).toHaveValue('pytorch');
    await expect(page.locator('#repo-input')).toHaveValue('org:pytorch\norg:meta-pytorch');

    await page.locator('#profile-select').selectOption('everything-else');
    await expect(page.locator('#repo-input')).toHaveValue('-org:pytorch -org:meta-pytorch');
  });

  test('syncs all entries in the active profile', async ({ page }) => {
    const seenQueries: string[] = [];
    await page.route('**/notifications/html/query**', (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('query') || '';
      seenQueries.push(query);
      const repo = query === 'org:pytorch' ? 'pytorch/pytorch' : 'meta-pytorch/test';
      const title = query === 'org:pytorch' ? 'PyTorch issue' : 'Meta PyTorch issue';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response(repo, [notification(`notif-${seenQueries.length}`, repo, title, seenQueries.length)])),
      });
    });

    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 2 notifications');
    await expect(page.locator('.notification-item')).toHaveCount(2);
    expect(seenQueries).toEqual(['org:pytorch', 'org:meta-pytorch']);
  });

  test('full sync supports the default PyTorch profile', async ({ page }) => {
    const seenQueries: string[] = [];
    await page.route('**/notifications/html/query**', (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('query') || '';
      seenQueries.push(query);
      const repo = query === 'org:pytorch' ? 'pytorch/pytorch' : 'meta-pytorch/test';
      const title = query === 'org:pytorch' ? 'PyTorch issue' : 'Meta PyTorch issue';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response(repo, [
          notification(`notif-full-${seenQueries.length}`, repo, title, seenQueries.length),
        ])),
      });
    });

    await page.locator('#full-sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 2 notifications');
    await expect(page.locator('.notification-item')).toHaveCount(2);
    expect(seenQueries).toEqual(['org:pytorch', 'org:meta-pytorch']);
  });

  test('remembers custom profiles with multiple repositories', async ({ page }) => {
    await page.locator('#profile-select').selectOption('custom');
    await page.locator('#repo-input').fill('test/repo\nother/repo');

    await page.reload();

    await expect(page.locator('#profile-select')).toHaveValue('custom');
    await expect(page.locator('#repo-input')).toHaveValue('test/repo\nother/repo');
    await expect.poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('ghnotif_profiles') || '[]'))
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'custom',
          entries: ['test/repo', 'other/repo'],
        }),
      ])
    );
  });
});
