import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  clearAppStorage,
  readNotificationsCache,
  seedCommentCache,
  seedNotificationsCache,
} from './storage-utils';

/**
 * Phase 3: Sync & IndexedDB Tests
 *
 * Tests for fetching notifications from API, pagination, and IndexedDB persistence.
 */

// Load fixture data
const fixturesDir = join(__dirname, '..', 'fixtures');
const emptyResponse = JSON.parse(readFileSync(join(fixturesDir, 'notifications_empty.json'), 'utf-8'));
const mixedResponse = JSON.parse(readFileSync(join(fixturesDir, 'notifications_mixed.json'), 'utf-8'));

test.describe('Sync Functionality @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    // Mock auth endpoint
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    // Navigate first, then clear cached storage (so it doesn't clear on reload)
    await page.goto('notifications.html');
    await clearAppStorage(page);
    // Ensure we're on the default (no active subfilter) for Issues view
    const expandIssuesToggle = page.locator('#comment-expand-issues-toggle');
    if (await expandIssuesToggle.isChecked()) {
      await expandIssuesToggle.uncheck();
    }
    const expandPrsToggle = page.locator('#comment-expand-prs-toggle');
    if (await expandPrsToggle.isChecked()) {
      await expandPrsToggle.uncheck();
    }
    const hideToggle = page.locator('#comment-hide-uninteresting-toggle');
    if (await hideToggle.isChecked()) {
      await hideToggle.uncheck();
    }
  });

  test('sync button triggers API call', async ({ page }) => {
    let apiCalled = false;

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      apiCalled = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    // Enter repo and click sync
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    // Wait for sync to complete
    await expect(page.locator('#status-bar')).toContainText('Synced');

    expect(apiCalled).toBe(true);
  });

  test('sync fetches notifications and displays count @smoke', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    // Wait for sync to complete
    await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');

    // Check notification count in header
    await expect(page.locator('#notification-count')).toContainText('4 notifications');
  });

  test('session-expired sync response redirects to login refresh', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          detail: {
            error: 'session_expired',
            message: 'GitHub session has expired. Please re-authenticate.',
          },
        }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Session expired');
    await expect(page).toHaveURL(/\/app\/login\.html\?session_refresh=1/);
  });

  test('sync stores notifications in IndexedDB', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    // Wait for sync to complete
    await expect(page.locator('#status-bar')).toContainText('Synced');

    const stored = await readNotificationsCache(page);

    expect(Array.isArray(stored)).toBe(true);
    if (Array.isArray(stored)) {
      expect(stored.length).toBe(5);
      expect(stored[0].subject.title).toBeTruthy();
    }
  });

  test('quick sync stops after hitting an unchanged notification', async ({ page }) => {
    const previousNotifications = [
      {
        id: 'prev-1',
        unread: true,
        reason: 'author',
        updated_at: '2024-12-27T10:00:00Z',
        subject: {
          title: 'Previous notification 1',
          url: 'https://github.com/test/repo/issues/1',
          type: 'Issue',
          number: 1,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
      {
        id: 'prev-2',
        unread: false,
        reason: 'mention',
        updated_at: '2024-12-27T09:00:00Z',
        subject: {
          title: 'Previous notification 2',
          url: 'https://github.com/test/repo/issues/2',
          type: 'Issue',
          number: 2,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
      {
        id: 'prev-3',
        unread: false,
        reason: 'mention',
        updated_at: '2024-12-27T08:00:00Z',
        subject: {
          title: 'Previous notification 3',
          url: 'https://github.com/test/repo/issues/3',
          type: 'Issue',
          number: 3,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
    ];

    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
      localStorage.setItem('ghnotif_last_synced_repo', 'test/repo');
    });
    await seedNotificationsCache(page, previousNotifications);
    await page.reload();

    const page1Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'new-1',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T11:00:00Z',
          subject: {
            title: 'New notification',
            url: 'https://github.com/test/repo/issues/99',
            type: 'Issue',
            number: 99,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
        {
          id: 'api-1',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T10:00:00Z',
          subject: {
            title: 'Previous notification 1',
            url: 'https://github.com/test/repo/issues/1',
            type: 'Issue',
            number: 1,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: null,
        after_cursor: 'cursor123',
        has_previous: false,
        has_next: true,
      },
    };

    const page2Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'api-2',
          unread: false,
          reason: 'mention',
          updated_at: '2024-12-27T09:00:00Z',
          subject: {
            title: 'API notification 2',
            url: 'https://github.com/test/repo/issues/2',
            type: 'Issue',
            number: 2,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: 'cursor123',
        after_cursor: null,
        has_previous: true,
        has_next: false,
      },
    };

    let requestCount = 0;

    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      requestCount += 1;
      const url = route.request().url();

      if (url.includes('after=cursor123')) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page2Response),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page1Response),
        });
      }
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 4 notifications');
    expect(requestCount).toBe(1);

    const stored = await readNotificationsCache(page);
    expect((stored as { id: string }[]).map((notif) => notif.id)).toEqual([
      'new-1',
      'api-1',
      'prev-2',
      'prev-3',
    ]);
  });

  test('quick sync skips extra REST pages after hitting cached notifications', async ({ page }) => {
    const previousNotifications = [
      {
        id: 'prev-1',
        unread: true,
        reason: 'author',
        updated_at: '2024-12-27T10:00:00Z',
        subject: {
          title: 'Previous notification 1',
          url: 'https://github.com/test/repo/issues/1',
          type: 'Issue',
          number: 1,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
      {
        id: 'prev-2',
        unread: false,
        reason: 'mention',
        updated_at: '2024-12-27T09:00:00Z',
        subject: {
          title: 'Previous notification 2',
          url: 'https://github.com/test/repo/issues/2',
          type: 'Issue',
          number: 2,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
    ];

    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
      localStorage.setItem('ghnotif_last_synced_repo', 'test/repo');
    });
    await seedNotificationsCache(page, previousNotifications);
    await page.reload();

    const page1Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'new-1',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T11:00:00Z',
          subject: {
            title: 'New notification',
            url: 'https://github.com/test/repo/issues/99',
            type: 'Issue',
            number: 99,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
        {
          id: 'api-1',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T10:00:00Z',
          subject: {
            title: 'Previous notification 1',
            url: 'https://github.com/test/repo/issues/1',
            type: 'Issue',
            number: 1,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: null,
        after_cursor: 'cursor123',
        has_previous: false,
        has_next: true,
      },
    };

    const page2Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'api-2',
          unread: false,
          reason: 'mention',
          updated_at: '2024-12-27T09:00:00Z',
          subject: {
            title: 'API notification 2',
            url: 'https://github.com/test/repo/issues/2',
            type: 'Issue',
            number: 2,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: 'cursor123',
        after_cursor: null,
        has_previous: true,
        has_next: false,
      },
    };

    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          resources: {
            core: {
              remaining: 42,
              limit: 60,
              reset: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      });
    });

    let restRequestCount = 0;
    await page.route('**/github/rest/notifications**', (route) => {
      restRequestCount += 1;
      const url = new URL(route.request().url());
      const pageParam = url.searchParams.get('page');
      const payload =
        pageParam === '2'
          ? [
              {
                id: 'rest-2',
                repository: { full_name: 'test/repo' },
                subject: {
                  type: 'Issue',
                  url: 'https://api.github.com/repos/test/repo/issues/2',
                },
                last_read_at: '2024-12-27T09:30:00Z',
              },
            ]
          : [
              {
                id: 'rest-1',
                repository: { full_name: 'test/repo' },
                subject: {
                  type: 'Issue',
                  url: 'https://api.github.com/repos/test/repo/issues/99',
                },
                last_read_at: '2024-12-27T11:10:00Z',
              },
              {
                id: 'rest-1b',
                repository: { full_name: 'test/repo' },
                subject: {
                  type: 'Issue',
                  url: 'https://api.github.com/repos/test/repo/issues/1',
                },
                last_read_at: '2024-12-27T10:10:00Z',
              },
            ];
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });

    let requestCount = 0;
    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      requestCount += 1;
      const url = route.request().url();

      if (url.includes('after=cursor123')) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page2Response),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page1Response),
        });
      }
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 3 notifications');
    expect(requestCount).toBe(1);
    expect(restRequestCount).toBe(1);
  });

  test('quick sync skips REST lookup when no new notifications', async ({ page }) => {
    const previousNotifications = [
      {
        id: 'prev-1',
        unread: true,
        reason: 'author',
        updated_at: '2024-12-27T10:00:00Z',
        subject: {
          title: 'Previous notification 1',
          url: 'https://github.com/test/repo/issues/1',
          type: 'Issue',
          number: 1,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
      {
        id: 'prev-2',
        unread: false,
        reason: 'mention',
        updated_at: '2024-12-27T09:00:00Z',
        subject: {
          title: 'Previous notification 2',
          url: 'https://github.com/test/repo/issues/2',
          type: 'Issue',
          number: 2,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
    ];

    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
      localStorage.setItem('ghnotif_last_synced_repo', 'test/repo');
    });
    await seedNotificationsCache(page, previousNotifications);
    await page.reload();

    const page1Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'api-1',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T10:00:00Z',
          subject: {
            title: 'Previous notification 1',
            url: 'https://github.com/test/repo/issues/1',
            type: 'Issue',
            number: 1,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
        {
          id: 'api-2',
          unread: false,
          reason: 'mention',
          updated_at: '2024-12-27T09:00:00Z',
          subject: {
            title: 'Previous notification 2',
            url: 'https://github.com/test/repo/issues/2',
            type: 'Issue',
            number: 2,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: null,
        after_cursor: 'cursor123',
        has_previous: false,
        has_next: true,
      },
    };

    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          resources: {
            core: {
              remaining: 42,
              limit: 60,
              reset: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      });
    });

    let restRequestCount = 0;
    await page.route('**/github/rest/notifications**', (route) => {
      restRequestCount += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    let requestCount = 0;
    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      requestCount += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(page1Response),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 2 notifications');
    expect(requestCount).toBe(1);
    expect(restRequestCount).toBe(0);
  });

  test('quick sync matches notifications with equivalent updated_at formats', async ({ page }) => {
    const previousNotifications = [
      {
        id: 'prev-1',
        unread: true,
        reason: 'author',
        updated_at: '2024-12-27T10:00:00Z',
        subject: {
          title: 'Previous notification 1',
          url: 'https://github.com/test/repo/issues/1',
          type: 'Issue',
          number: 1,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
      {
        id: 'prev-2',
        unread: false,
        reason: 'mention',
        updated_at: '2024-12-27T09:00:00Z',
        subject: {
          title: 'Previous notification 2',
          url: 'https://github.com/test/repo/issues/2',
          type: 'Issue',
          number: 2,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
    ];

    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
      localStorage.setItem('ghnotif_last_synced_repo', 'test/repo');
    });
    await seedNotificationsCache(page, previousNotifications);
    await page.reload();

    const page1Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'new-1',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T11:00:00+00:00',
          subject: {
            title: 'New notification',
            url: 'https://github.com/test/repo/issues/99',
            type: 'Issue',
            number: 99,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
        {
          id: 'api-1',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T10:00:00+00:00',
          subject: {
            title: 'Previous notification 1',
            url: 'https://github.com/test/repo/issues/1',
            type: 'Issue',
            number: 1,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: null,
        after_cursor: 'cursor123',
        has_previous: false,
        has_next: true,
      },
    };

    const page2Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'api-2',
          unread: false,
          reason: 'mention',
          updated_at: '2024-12-27T09:00:00+00:00',
          subject: {
            title: 'API notification 2',
            url: 'https://github.com/test/repo/issues/2',
            type: 'Issue',
            number: 2,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: 'cursor123',
        after_cursor: null,
        has_previous: true,
        has_next: false,
      },
    };

    let requestCount = 0;

    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      requestCount += 1;
      const url = route.request().url();

      if (url.includes('after=cursor123')) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page2Response),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page1Response),
        });
      }
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 3 notifications');
    expect(requestCount).toBe(1);

    const stored = await readNotificationsCache(page);
    expect((stored as { id: string }[]).map((notif) => notif.id)).toEqual([
      'new-1',
      'api-1',
      'prev-2',
    ]);
  });

  test('full sync loads every page even with unchanged notifications', async ({ page }) => {
    const previousNotifications = [
      {
        id: 'prev-1',
        unread: true,
        reason: 'author',
        updated_at: '2024-12-27T10:00:00Z',
        subject: {
          title: 'Previous notification 1',
          url: 'https://github.com/test/repo/issues/1',
          type: 'Issue',
          number: 1,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
      {
        id: 'prev-2',
        unread: false,
        reason: 'mention',
        updated_at: '2024-12-27T09:00:00Z',
        subject: {
          title: 'Previous notification 2',
          url: 'https://github.com/test/repo/issues/2',
          type: 'Issue',
          number: 2,
          state: 'open',
          state_reason: null,
        },
        actors: [],
        ui: { saved: false, done: false },
      },
    ];

    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
      localStorage.setItem('ghnotif_last_synced_repo', 'test/repo');
    });
    await seedNotificationsCache(page, previousNotifications);
    await page.reload();

    const page1Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'new-1',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T11:00:00Z',
          subject: {
            title: 'New notification',
            url: 'https://github.com/test/repo/issues/99',
            type: 'Issue',
            number: 99,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
        {
          id: 'api-1',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T10:00:00Z',
          subject: {
            title: 'Previous notification 1',
            url: 'https://github.com/test/repo/issues/1',
            type: 'Issue',
            number: 1,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: null,
        after_cursor: 'cursor123',
        has_previous: false,
        has_next: true,
      },
    };

    const page2Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'api-2',
          unread: false,
          reason: 'mention',
          updated_at: '2024-12-27T09:00:00Z',
          subject: {
            title: 'API notification 2',
            url: 'https://github.com/test/repo/issues/2',
            type: 'Issue',
            number: 2,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
        {
          id: 'api-3',
          unread: false,
          reason: 'mention',
          updated_at: '2024-12-27T08:00:00Z',
          subject: {
            title: 'API notification 3',
            url: 'https://github.com/test/repo/issues/3',
            type: 'Issue',
            number: 3,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: 'cursor123',
        after_cursor: null,
        has_previous: true,
        has_next: false,
      },
    };

    let requestCount = 0;

    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      requestCount += 1;
      const url = route.request().url();

      if (url.includes('after=cursor123')) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page2Response),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page1Response),
        });
      }
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#full-sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 4 notifications');
    expect(requestCount).toBe(2);

    const stored = await readNotificationsCache(page);
    expect((stored as { id: string }[]).map((notif) => notif.id)).toEqual([
      'new-1',
      'api-1',
      'api-2',
      'api-3',
    ]);
  });

  test('full sync starts stable comment prefetch before later pages finish', async ({ page }) => {
    const page1Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'api-1',
          unread: true,
          reason: 'mention',
          updated_at: '2024-12-27T11:00:00Z',
          subject: {
            title: 'Page 1 notification',
            url: 'https://github.com/test/repo/issues/1#issuecomment-101',
            type: 'Issue',
            number: 1,
            anchor: 'issuecomment-101',
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: null,
        after_cursor: 'cursor123',
        has_previous: false,
        has_next: true,
      },
    };

    const page2Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'api-2',
          unread: true,
          reason: 'mention',
          updated_at: '2024-12-27T10:00:00Z',
          subject: {
            title: 'Page 2 notification',
            url: 'https://github.com/test/repo/issues/2',
            type: 'Issue',
            number: 2,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: 'cursor123',
        after_cursor: null,
        has_previous: true,
        has_next: false,
      },
    };

    let releasePage2!: () => void;
    const page2Gate = new Promise<void>((resolve) => {
      releasePage2 = resolve;
    });
    let page2Requested = false;
    let commentRequestCount = 0;

    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          resources: {
            core: {
              remaining: 42,
              limit: 60,
              reset: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      });
    });

    await page.route('**/github/rest/repos/test/repo/issues/1', (route) => {
      commentRequestCount += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 101,
          body: 'Issue body',
          created_at: '2024-12-27T09:00:00Z',
          updated_at: '2024-12-27T09:00:00Z',
          user: { login: 'author' },
        }),
      });
    });

    await page.route('**/github/rest/repos/test/repo/issues/1/comments', (route) => {
      commentRequestCount += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 101,
            body: 'Unread comment',
            created_at: '2024-12-27T11:00:00Z',
            updated_at: '2024-12-27T11:00:00Z',
            user: { login: 'commenter' },
          },
        ]),
      });
    });

    await page.route('**/github/rest/notifications**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/notifications/html/repo/test/repo**', async (route) => {
      const url = route.request().url();

      if (url.includes('after=cursor123')) {
        page2Requested = true;
        await page2Gate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page2Response),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(page1Response),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#full-sync-btn').click();

    await expect.poll(() => page2Requested).toBe(true);
    await expect.poll(() => commentRequestCount).toBeGreaterThan(0);

    releasePage2();
    await expect(page.locator('#status-bar')).toContainText('Synced 2 notifications');
    expect(commentRequestCount).toBeGreaterThan(0);
  });

  test('full sync runs on server and applies returned snapshot', async ({ page }) => {
    const snapshotNotification = {
      id: 'server-1',
      unread: true,
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: {
        title: 'Server snapshot notification',
        url: 'https://github.com/test/repo/issues/42',
        type: 'Issue',
        number: 42,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    };
    let syncStarted = false;
    let htmlFetchCalled = false;
    let runningStatusPolled = false;
    let finishSync: () => void;
    const syncCanFinish = new Promise<void>((resolve) => {
      finishSync = resolve;
    });

    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      htmlFetchCalled = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });
    await page.route('**/api/snapshots/test/repo/sync', async (route) => {
      if (route.request().method() === 'POST') {
        syncStarted = true;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
            sync: {
              status: 'running',
              mode: 'full',
              pages_fetched: 0,
              notifications_count: 0,
            },
          }),
        });
        return;
      }
      if (!runningStatusPolled) {
        runningStatusPolled = true;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
            sync: {
              status: 'running',
              mode: 'full',
              pages_fetched: 1,
              notifications_count: 1,
            },
          }),
        });
        return;
      }
      await syncCanFinish;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
          sync: {
            status: 'success',
            mode: 'full',
            pages_fetched: 1,
            notifications_count: 1,
          },
          snapshot: {
            notifications: [snapshotNotification],
            authenticity_token: 'server-token',
            synced_at: '2024-12-27T12:01:00+00:00',
          },
        }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#full-sync-btn').click();

    await expect.poll(() => runningStatusPolled).toBe(true);
    await expect(page.locator('#status-bar')).not.toContainText('Full Sync running on server', { timeout: 1200 });
    finishSync!();
    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');
    await expect(page.locator('[data-id="server-1"]')).toBeVisible();
    expect(syncStarted).toBe(true);
    expect(htmlFetchCalled).toBe(false);
  });

  test('server refresh applies server snapshot without syncing GitHub', async ({ page }) => {
    const staleNotification = {
      id: 'server-refresh-stale-1',
      unread: true,
      reason: 'mention',
      updated_at: '2024-12-26T12:00:00Z',
      subject: {
        title: 'Stale local notification',
        url: 'https://github.com/test/repo/issues/41',
        type: 'Issue',
        number: 41,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    };
    const snapshotNotification = {
      id: 'server-refresh-current-1',
      unread: true,
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: {
        title: 'Current server snapshot notification',
        url: 'https://github.com/test/repo/issues/42',
        type: 'Issue',
        number: 42,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    };
    let snapshotFetched = false;
    let serveSnapshot = false;
    let syncPosted = false;
    let htmlFetched = false;

    await page.route('**/api/snapshots/test/repo', (route) => {
      snapshotFetched = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
          snapshot: serveSnapshot
            ? {
                notifications: [snapshotNotification],
                authenticity_token: 'server-token',
                synced_at: '2024-12-27T12:01:00+00:00',
              }
            : null,
          sync: { status: 'idle', mode: 'full' },
        }),
      });
    });
    await page.route('**/api/snapshots/test/repo/sync', (route) => {
      if (route.request().method() === 'POST') {
        syncPosted = true;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sync: { status: 'idle', mode: 'full' }, snapshot: null }),
      });
    });
    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      htmlFetched = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await seedNotificationsCache(page, [staleNotification]);
    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
      localStorage.setItem('ghnotif_last_synced_repo', 'test/repo');
    });
    await page.reload();
    await expect(page.locator('[data-id="server-refresh-stale-1"]')).toBeVisible();

    snapshotFetched = false;
    serveSnapshot = true;
    await page.locator('#server-refresh-btn').click();

    await expect(page.locator('[data-id="server-refresh-current-1"]')).toBeVisible();
    await expect(page.locator('[data-id="server-refresh-stale-1"]')).toHaveCount(0);
    await expect(page.locator('#status-bar')).toContainText('Loaded 1 notifications from server snapshot');
    expect(snapshotFetched).toBe(true);
    expect(syncPosted).toBe(false);
    expect(htmlFetched).toBe(false);
  });

  test('loads server snapshot on startup when local cache is empty', async ({ page }) => {
    const snapshotNotification = {
      id: 'server-startup-1',
      unread: true,
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: {
        title: 'Loaded from server on startup',
        url: 'https://github.com/test/repo/issues/42',
        type: 'Issue',
        number: 42,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    };

    await page.route('**/api/snapshots/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
          snapshot: {
            notifications: [snapshotNotification],
            authenticity_token: 'server-token',
            synced_at: '2024-12-27T12:01:00+00:00',
          },
          sync: { status: 'idle', mode: 'full' },
        }),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
    });
    await page.reload();

    await expect(page.locator('[data-id="server-startup-1"]')).toBeVisible();
    await expect(page.locator('#status-bar')).toContainText('Loaded server snapshot');
  });

  test('startup server snapshot reuses fresh local comment cache', async ({ page }) => {
    const snapshotNotification = {
      id: 'server-cached-comments-1',
      unread: true,
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: {
        title: 'Loaded with cached comments',
        url: 'https://github.com/test/repo/issues/42',
        type: 'Issue',
        number: 42,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    };
    let bulkCommentRequests = 0;
    let individualCommentRequests = 0;

    await page.route('**/api/snapshots/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
          snapshot: {
            notifications: [snapshotNotification],
            authenticity_token: 'server-token',
            synced_at: '2024-12-27T12:01:00+00:00',
          },
          sync: { status: 'idle', mode: 'full' },
        }),
      });
    });
    await page.route('**/github/rest/comments/bulk', (route) => {
      bulkCommentRequests += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ threads: {} }),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      individualCommentRequests += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await seedCommentCache(page, {
      version: 1,
      threads: {
        'server-cached-comments-1': {
          notificationUpdatedAt: '2024-12-27T12:00:00Z',
          comments: [
            {
              id: 1001,
              body: 'Already cached',
              created_at: '2024-12-27T12:00:00Z',
              updated_at: '2024-12-27T12:00:00Z',
              user: { login: 'commenter' },
            },
          ],
          allComments: true,
          fetchedAt: new Date().toISOString(),
        },
      },
    });
    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
    });
    await page.reload();

    await expect(page.locator('[data-id="server-cached-comments-1"]')).toBeVisible();
    await expect(page.locator('#comment-cache-status')).toContainText('Comments cached: 1');
    expect(bulkCommentRequests).toBe(0);
    expect(individualCommentRequests).toBe(0);
  });

  test('startup server snapshot fetches missing comments in bulk', async ({ page }) => {
    const snapshotNotification = {
      id: 'server-bulk-comments-1',
      unread: true,
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: {
        title: 'Loaded with bulk comments',
        url: 'https://github.com/test/repo/issues/42',
        type: 'Issue',
        number: 42,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    };
    let bulkCommentRequests = 0;
    let individualCommentRequests = 0;

    await page.route('**/api/snapshots/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
          snapshot: {
            notifications: [snapshotNotification],
            authenticity_token: 'server-token',
            synced_at: '2024-12-27T12:01:00+00:00',
          },
          sync: { status: 'idle', mode: 'full' },
        }),
      });
    });
    await page.route('**/github/rest/comments/bulk', async (route) => {
      bulkCommentRequests += 1;
      const body = route.request().postDataJSON();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        key: 'server-bulk-comments-1',
        owner: 'test',
        repo: 'repo',
        number: 42,
        is_pr: false,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          threads: {
            'server-bulk-comments-1': {
              comments: [
                {
                  id: 1002,
                  body: 'Fetched in bulk',
                  created_at: '2024-12-27T12:00:00Z',
                  updated_at: '2024-12-27T12:00:00Z',
                  user: { login: 'commenter' },
                },
              ],
              allComments: true,
            },
          },
        }),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      individualCommentRequests += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
    });
    await page.reload();

    await expect(page.locator('[data-id="server-bulk-comments-1"]')).toBeVisible();
    await expect(page.locator('#comment-cache-status')).toContainText('Comments cached: 1');
    await expect.poll(() => bulkCommentRequests).toBe(1);
    expect(individualCommentRequests).toBe(0);
  });

  test('startup prefers server snapshot over stale local cache without syncing', async ({ page }) => {
    const staleNotification = {
      id: 'stale-local-1',
      unread: true,
      reason: 'mention',
      updated_at: '2024-12-26T12:00:00Z',
      subject: {
        title: 'Stale local cache notification',
        url: 'https://github.com/test/repo/issues/41',
        type: 'Issue',
        number: 41,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    };
    const snapshotNotification = {
      id: 'server-startup-current-1',
      unread: true,
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: {
        title: 'Current server snapshot notification',
        url: 'https://github.com/test/repo/issues/42',
        type: 'Issue',
        number: 42,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    };
    let syncPosted = false;
    let htmlFetched = false;

    await page.route('**/api/snapshots/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
          snapshot: {
            notifications: [snapshotNotification],
            authenticity_token: 'server-token',
            synced_at: '2024-12-27T12:01:00+00:00',
          },
          sync: { status: 'idle', mode: 'full' },
        }),
      });
    });
    await page.route('**/api/snapshots/test/repo/sync', (route) => {
      if (route.request().method() === 'POST') {
        syncPosted = true;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sync: { status: 'idle', mode: 'full' }, snapshot: null }),
      });
    });
    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      htmlFetched = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await seedNotificationsCache(page, [staleNotification]);
    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
      localStorage.setItem('ghnotif_last_synced_repo', 'test/repo');
      localStorage.setItem(
        'ghnotif_server_snapshot_synced_at:test/repo',
        '2024-12-27T12:01:00+00:00'
      );
    });
    await page.reload();

    await expect(page.locator('[data-id="server-startup-current-1"]')).toBeVisible();
    await expect(page.locator('[data-id="stale-local-1"]')).toHaveCount(0);
    expect(syncPosted).toBe(false);
    expect(htmlFetched).toBe(false);
  });

  test('loads review-request entries from server snapshot into others PRs', async ({ page }) => {
    const reviewRequestNotification = {
      id: 'review-request:test/repo#10',
      unread: false,
      reason: 'review_requested',
      responsibility_source: 'review-requested',
      updated_at: '2025-01-05T12:00:00Z',
      last_read_at: '2025-01-05T12:00:00Z',
      subject: {
        title: 'Snapshot review request',
        url: 'https://github.com/test/repo/pull/10',
        type: 'PullRequest',
        number: 10,
        state: 'open',
        state_reason: null,
      },
      actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
      ui: { saved: false, done: false, action_tokens: {} },
    };

    await page.route('**/api/snapshots/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
          snapshot: {
            notifications: [reviewRequestNotification],
            authenticity_token: 'server-token',
            synced_at: '2025-01-05T12:01:00+00:00',
          },
          sync: { status: 'idle', mode: 'full' },
        }),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/10/comments*', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/github/rest/repos/test/repo/pulls/10/comments*', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/github/rest/repos/test/repo/collaborators/alice/permission', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permission: 'write', role_name: 'write' }),
      });
    });
    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              limit: 5000,
              remaining: 4999,
              resetAt: '2025-01-05T00:00:00Z',
            },
            repository: {
              pr10: {
                reviewDecision: null,
                authorAssociation: 'MEMBER',
                additions: 5,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'alice' },
              },
            },
          },
        }),
      });
    });

    await page.evaluate(() => {
      localStorage.setItem('ghnotif_repo', 'test/repo');
    });
    await page.reload();

    await expect(page.locator('#status-bar')).toContainText('Loaded server snapshot');
    await page.locator('#view-others-prs').click();
    await expect(page.locator('[data-id="review-request:test/repo#10"]')).toBeVisible();
    await expect(page.locator('#view-others-prs .count')).toHaveText('1');
  });

  test('notifications persist across page reload', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    // beforeEach already navigated and cleared localStorage

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced');

    // Verify notifications are in IndexedDB before reload
    const storedBefore = await readNotificationsCache(page);
    expect(Array.isArray(storedBefore)).toBe(true);

    // Reload the page (route mocks persist in Playwright)
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Notifications should still be displayed (loaded from IndexedDB)
    await expect(page.locator('#notification-count')).toContainText('4 notifications');

    // Empty state should be hidden
    await expect(page.locator('#empty-state')).not.toBeVisible();
  });

  test('sync shows loading state', async ({ page }) => {
    // Use a delayed response to observe loading state
    await page.route('**/notifications/html/repo/test/repo', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    // Loading state should be visible
    await expect(page.locator('#loading')).toBeVisible();

    // Wait for sync to complete
    await expect(page.locator('#status-bar')).toContainText('Synced');

    // Loading state should be hidden
    await expect(page.locator('#loading')).not.toBeVisible();
  });

  test('sync shows progress status', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    // Should show syncing status (may be fast, so check for either syncing or synced)
    await expect(page.locator('#status-bar')).toBeVisible();
  });

  test('sync avoids detailed request log status while loading', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toContainText('Quick Sync in progress');
    await expect(statusBar).not.toContainText('requesting page 1');
    await expect(statusBar).toContainText('Synced');
    await expect(statusBar).toHaveClass(/auto-dismiss/);
  });

  test('sync hides empty state when notifications exist', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    // Empty state should be visible initially
    await expect(page.locator('#empty-state')).toBeVisible();

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced');

    // Empty state should be hidden
    await expect(page.locator('#empty-state')).not.toBeVisible();
  });

  test('sync shows empty state when no notifications', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 0 notifications');

    // Empty state should be visible
    await expect(page.locator('#empty-state')).toBeVisible();
  });
});

test.describe('Pagination @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('sync traverses multiple pages', async ({ page }) => {
    const page1Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'notif-page1-1',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T12:00:00Z',
          subject: {
            title: 'Page 1 Notification 1',
            url: 'https://github.com/test/repo/issues/1',
            type: 'Issue',
            number: 1,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
        {
          id: 'notif-page1-2',
          unread: false,
          reason: 'mention',
          updated_at: '2024-12-27T11:00:00Z',
          subject: {
            title: 'Page 1 Notification 2',
            url: 'https://github.com/test/repo/issues/2',
            type: 'Issue',
            number: 2,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: null,
        after_cursor: 'cursor123',
        has_previous: false,
        has_next: true,
      },
    };

    const page2Response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'notif-page2-1',
          unread: true,
          reason: 'subscribed',
          updated_at: '2024-12-27T10:00:00Z',
          subject: {
            title: 'Page 2 Notification 1',
            url: 'https://github.com/test/repo/issues/3',
            type: 'Issue',
            number: 3,
            state: 'closed',
            state_reason: 'completed',
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
      pagination: {
        before_cursor: 'cursor123',
        after_cursor: null,
        has_previous: true,
        has_next: false,
      },
    };

    let requestCount = 0;

    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      requestCount++;
      const url = route.request().url();

      if (url.includes('after=cursor123')) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page2Response),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page1Response),
        });
      }
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    // Wait for sync to complete
    await expect(page.locator('#status-bar')).toContainText('Synced 3 notifications');

    // Should have made 2 API requests
    expect(requestCount).toBe(2);

    // All notifications should be stored
    const stored = await readNotificationsCache(page);
    expect((stored as unknown[]).length).toBe(3);
  });

  test('notifications are sorted by updated_at descending', async ({ page }) => {
    const response = {
      ...emptyResponse,
      notifications: [
        {
          id: 'old',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-25T10:00:00Z',
          subject: { title: 'Old notification', url: '#', type: 'Issue', number: 1, state: 'open', state_reason: null },
          actors: [],
          ui: { saved: false, done: false },
        },
        {
          id: 'new',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-27T10:00:00Z',
          subject: { title: 'New notification', url: '#', type: 'Issue', number: 2, state: 'open', state_reason: null },
          actors: [],
          ui: { saved: false, done: false },
        },
        {
          id: 'middle',
          unread: true,
          reason: 'author',
          updated_at: '2024-12-26T10:00:00Z',
          subject: { title: 'Middle notification', url: '#', type: 'Issue', number: 3, state: 'open', state_reason: null },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
    };

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced');

    // Verify order in IndexedDB
    const stored = await readNotificationsCache(page);

    const storedList = stored as { id: string }[];
    expect(storedList[0].id).toBe('new');
    expect(storedList[1].id).toBe('middle');
    expect(storedList[2].id).toBe('old');
  });
});

test.describe('Error Handling @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('shows error on API failure', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Internal server error' }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    // Should show error
    await expect(page.locator('#status-bar')).toContainText('Sync failed');
    await expect(page.locator('#status-bar')).toHaveClass(/error/);
  });

  test('shows error on network failure', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.abort('failed');
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    // Should show error
    await expect(page.locator('#status-bar')).toContainText('Sync failed');
    await expect(page.locator('#status-bar')).toHaveClass(/error/);
  });

  test('shows specific error message from API', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Failed to fetch from GitHub: timeout' }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    // Should show the specific error message
    await expect(page.locator('#status-bar')).toContainText('timeout');
  });

  test('keeps error status visible when message text is clicked', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          detail:
            'It looks like you are using Playwright Sync API inside the asyncio loop. Please use the Async API instead.',
        }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toContainText('Playwright Sync API inside the asyncio loop');
    await expect(statusBar.locator('.status-close-btn')).toBeVisible();

    await statusBar.locator('.status-message').click();
    await expect(statusBar).toContainText('Playwright Sync API inside the asyncio loop');

    await statusBar.locator('.status-close-btn').click();
    await expect(statusBar).not.toBeVisible();
  });

  test('loading state is hidden after error', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Error' }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Sync failed');

    // Loading should be hidden
    await expect(page.locator('#loading')).not.toBeVisible();
  });

  test('preserves existing notifications on sync error', async ({ page }) => {
    // First, do a successful sync
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 5');

    // Now make the API fail
    await page.unroute('**/notifications/html/repo/test/repo');
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Error' }),
      });
    });

    // Try to sync again
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Sync failed');

    // Original notifications should still be displayed
    await expect(page.locator('#notification-count')).toContainText('4 notifications');
  });
});

test.describe('Notifications Display @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('displays notification titles in list', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced');

    // Check that notification titles are displayed
    const list = page.locator('#notifications-list');
    await expect(list.locator('.notification-item')).toHaveCount(4);

    // First notification should have its title
    await expect(list.locator('.notification-item').first()).toContainText('Fix critical bug in authentication');
  });

  test('notification items have data-id attribute', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced');

    // Check data-id attributes
    const firstItem = page.locator('#notifications-list li').first();
    const dataId = await firstItem.getAttribute('data-id');
    expect(dataId).toBeTruthy();
  });
});
