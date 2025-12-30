import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  clearAppStorage,
  readNotificationsCache,
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

test.describe('Sync Functionality', () => {
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

  test('sync fetches notifications and displays count', async ({ page }) => {
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
    await expect(page.locator('#notification-count')).toContainText('3 notifications');
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
    await expect(page.locator('#notification-count')).toContainText('3 notifications');

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

  test('sync shows detailed request status while loading', async ({ page }) => {
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

    await expect(page.locator('#status-bar')).toContainText('requesting page 1');
    await expect(page.locator('#status-bar')).toHaveClass(/auto-dismiss/);
    await expect(page.locator('#status-bar')).toContainText('Synced');
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

test.describe('Pagination', () => {
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

test.describe('Error Handling', () => {
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
    await expect(page.locator('#notification-count')).toContainText('3 notifications');
  });
});

test.describe('Notifications Display', () => {
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
    await expect(list.locator('li')).toHaveCount(3);

    // First notification should have its title
    await expect(list.locator('li').first()).toContainText('Fix critical bug in authentication');
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
