import { test, expect } from '@playwright/test';
import { openNotificationsWithCommentCache } from './app-fixture';

const notificationsResponse = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2025-01-02T00:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    // Issue with interesting comments
    {
      id: 'thread-interesting',
      unread: true,
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Issue with interesting comments',
        url: 'https://github.com/test/repo/issues/1',
        type: 'Issue',
        number: 1,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
    // Issue with only bot comments
    {
      id: 'thread-bot-only',
      unread: true,
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Issue with bot comments only',
        url: 'https://github.com/test/repo/issues/2',
        type: 'Issue',
        number: 2,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
    // Issue with only bot commands
    {
      id: 'thread-bot-commands',
      unread: true,
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Issue with bot commands only',
        url: 'https://github.com/test/repo/issues/3',
        type: 'Issue',
        number: 3,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
    // Issue with no comments
    {
      id: 'thread-no-comments',
      unread: true,
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Issue with no comments',
        url: 'https://github.com/test/repo/issues/4',
        type: 'Issue',
        number: 4,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
  ],
  pagination: {
    before_cursor: null,
    after_cursor: null,
    has_previous: false,
    has_next: false,
  },
};

const commentCache = {
  version: 1,
  threads: {
    'thread-interesting': {
      notificationUpdatedAt: '2025-01-02T00:00:00Z',
      lastReadAt: '2025-01-01T00:00:00Z',
      unread: true,
      allComments: false,
      fetchedAt: new Date().toISOString(),
      comments: [
        {
          id: 101,
          user: { login: 'human' },
          body: 'This is an interesting comment from a human.',
          created_at: '2025-01-01T02:00:00Z',
          updated_at: '2025-01-01T02:00:00Z',
        },
      ],
    },
    'thread-bot-only': {
      notificationUpdatedAt: '2025-01-02T00:00:00Z',
      lastReadAt: '2025-01-01T00:00:00Z',
      unread: true,
      allComments: false,
      fetchedAt: new Date().toISOString(),
      comments: [
        {
          id: 201,
          user: { login: 'dependabot[bot]' },
          body: 'Bumps deps from 1.0 to 2.0',
          created_at: '2025-01-01T01:00:00Z',
          updated_at: '2025-01-01T01:00:00Z',
        },
        {
          id: 202,
          user: { login: 'github-actions[bot]' },
          body: 'CI passed',
          created_at: '2025-01-01T01:30:00Z',
          updated_at: '2025-01-01T01:30:00Z',
        },
      ],
    },
    'thread-bot-commands': {
      notificationUpdatedAt: '2025-01-02T00:00:00Z',
      lastReadAt: '2025-01-01T00:00:00Z',
      unread: true,
      allComments: false,
      fetchedAt: new Date().toISOString(),
      comments: [
        {
          id: 301,
          user: { login: 'human' },
          body: '@pytorchbot label feature',
          created_at: '2025-01-01T01:00:00Z',
          updated_at: '2025-01-01T01:00:00Z',
        },
        {
          id: 302,
          user: { login: 'human2' },
          body: '/merge',
          created_at: '2025-01-01T01:30:00Z',
          updated_at: '2025-01-01T01:30:00Z',
        },
      ],
    },
    'thread-no-comments': {
      notificationUpdatedAt: '2025-01-02T00:00:00Z',
      lastReadAt: '2025-01-01T00:00:00Z',
      unread: true,
      allComments: false,
      fetchedAt: new Date().toISOString(),
      comments: [],
    },
  },
};

test.describe('Interest Filter @classification', () => {
  test.beforeEach(async ({ page }) => {
    await openNotificationsWithCommentCache(page, {
      commentCache,
      expectedCount: 4,
      notifications: notificationsResponse,
    });
    await expect(page.locator('#status-bar')).toContainText('Synced');
  });

  test('displays interest filter tabs for Issues view', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );
    await expect(interestFilters).toBeVisible();
    await expect(interestFilters.locator('[data-subfilter="has-new"]')).toBeVisible();
    await expect(interestFilters.locator('[data-subfilter="no-new"]')).toBeVisible();
  });

  test('clicking Has new filter updates the active tab and list', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );

    await interestFilters.locator('[data-subfilter="has-new"]').click();
    await expect(interestFilters.locator('[data-subfilter="has-new"]')).toHaveClass(/active/);

    const items = page.locator('.notification-item');
    await expect(items).toHaveCount(1);
    await expect(page.locator('[data-id="thread-interesting"]')).toBeVisible();
  });

  test('clicking No new filter updates the active tab and list', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );

    await interestFilters.locator('[data-subfilter="no-new"]').click();
    await expect(interestFilters.locator('[data-subfilter="no-new"]')).toHaveClass(/active/);

    const items = page.locator('.notification-item');
    await expect(items).toHaveCount(3);
    await expect(page.locator('[data-id="thread-interesting"]')).not.toBeAttached();
  });

  test('clicking active interest filter clears the filter', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );

    // First click to activate
    await interestFilters.locator('[data-subfilter="has-new"]').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);

    // Second click to deactivate
    await interestFilters.locator('[data-subfilter="has-new"]').click();
    await expect(page.locator('.notification-item')).toHaveCount(4);
    await expect(interestFilters.locator('.subfilter-tab.active')).toHaveCount(0);
  });

  test('interest filter persists in localStorage', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );

    await interestFilters.locator('[data-subfilter="no-new"]').click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const savedViewFilters = localStorage.getItem('ghnotif_view_filters');
          return savedViewFilters ? JSON.parse(savedViewFilters).issues?.interest : null;
        })
      )
      .toBe('no-new');
  });

});
