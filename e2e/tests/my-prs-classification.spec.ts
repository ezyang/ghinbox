import { test, expect } from '@playwright/test';
import { addAuthCacheInitScript, clearAppStorage } from './storage-utils';

const fixture = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2024-12-27T12:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    {
      id: 'notif-issue-1',
      unread: true,
      reason: 'subscribed',
      updated_at: '2024-12-27T11:30:00Z',
      subject: {
        title: 'Issue: flaky tests',
        url: 'https://github.com/test/repo/issues/11',
        type: 'Issue',
        number: 11,
        state: 'open',
        state_reason: null,
      },
      actors: [
        {
          login: 'alice',
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
        },
      ],
      ui: {
        saved: false,
        done: false,
      },
    },
    {
      id: 'notif-pr-author',
      unread: true,
      reason: 'author',
      updated_at: '2024-12-27T10:00:00Z',
      subject: {
        title: 'PR: add new endpoint',
        url: 'https://github.com/test/repo/pull/12',
        type: 'PullRequest',
        number: 12,
        state: 'open',
        state_reason: null,
      },
      actors: [
        {
          login: 'reviewer',
          avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4',
        },
      ],
      ui: {
        saved: false,
        done: false,
      },
    },
    {
      id: 'notif-pr-comment',
      unread: false,
      reason: 'comment',
      updated_at: '2024-12-27T09:30:00Z',
      subject: {
        title: 'PR: improve docs',
        url: 'https://github.com/test/repo/pull/13',
        type: 'PullRequest',
        number: 13,
        state: 'open',
        state_reason: null,
      },
      actors: [
        {
          login: 'testuser',
          avatar_url: 'https://avatars.githubusercontent.com/u/3?v=4',
        },
      ],
      ui: {
        saved: false,
        done: false,
      },
    },
  ],
  pagination: {
    before_cursor: null,
    after_cursor: null,
    has_previous: false,
    has_next: false,
  },
};

test.describe('Feed and Reviews PR classification @classification', () => {
  test.beforeEach(async ({ page }) => {
    await addAuthCacheInitScript(page);

    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture),
      });
    });

    // Mock user endpoint for auth check
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    // Mock comments endpoint for syncNotificationBeforeDone
    await page.route('**/github/rest/repos/**/issues/*/comments', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/github/rest/repos/**/issues/**', (route) => {
      if (route.request().url().includes('/comments')) {
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, body: '', user: { login: 'testuser' } }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('keeps PR author notifications in Feed unless they are directed replies or reviews', async ({ page }) => {
    const input = page.locator('#repo-input');
    await input.fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 3 notifications');

    await expect(page.locator('#view-issues .count')).toHaveText('3');
    await expect(page.locator('#view-pr-notifications .count')).toHaveText('0');
    await expect(page.locator('#view-others-prs .count')).toHaveText('0');

    await page.locator('#view-issues').click();
    await expect(page.locator('.notification-item')).toHaveCount(3);
    await expect(page.locator('[data-id="notif-pr-author"]')).toBeVisible();
    await expect(page.locator('[data-id="notif-pr-comment"]')).toBeVisible();

    await page.locator('#view-pr-notifications').click();
    await expect(page.locator('.notification-item')).toHaveCount(0);
    await page.locator('#view-others-prs').click();
    await expect(page.locator('.notification-item')).toHaveCount(0);
  });

  test('uses PR metadata for review queues without promoting generic PR comments', async ({ page }) => {
    const graphqlFixture = {
      ...fixture,
      notifications: [
        {
          id: 'notif-pr-approved',
          unread: true,
          reason: 'approved',
          updated_at: '2024-12-27T09:00:00Z',
          subject: {
            title: 'PR: follow-up fix',
            url: 'https://github.com/test/repo/pull/14',
            type: 'PullRequest',
            number: 14,
            state: 'open',
            state_reason: null,
          },
          actors: [
            {
              login: 'reviewer',
              avatar_url: 'https://avatars.githubusercontent.com/u/4?v=4',
            },
          ],
          ui: {
            saved: false,
            done: false,
          },
        },
        {
          id: 'notif-pr-external',
          unread: true,
          reason: 'comment',
          updated_at: '2024-12-27T08:00:00Z',
          subject: {
            title: 'PR: external change',
            url: 'https://github.com/test/repo/pull/15',
            type: 'PullRequest',
            number: 15,
            state: 'open',
            state_reason: null,
          },
          actors: [
            {
              login: 'alice',
              avatar_url: 'https://avatars.githubusercontent.com/u/5?v=4',
            },
          ],
          ui: {
            saved: false,
            done: false,
          },
        },
      ],
    };

    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(graphqlFixture),
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
              resetAt: new Date().toISOString(),
            },
            repository: {
              pr14: {
                reviewDecision: 'APPROVED',
                authorAssociation: 'MEMBER',
                author: { login: 'testuser' },
              },
              pr15: {
                reviewDecision: null,
                authorAssociation: 'CONTRIBUTOR',
                author: { login: 'alice' },
              },
            },
          },
        }),
      });
    });

    const reviewMetadataResponse = page.waitForResponse((response) => {
      if (!response.url().includes('/github/graphql')) {
        return false;
      }
      const postData = response.request().postData() || '';
      return postData.includes('reviewDecision') && postData.includes('pullRequest');
    });
    const input = page.locator('#repo-input');
    await input.fill('test/repo');
    await page.locator('#sync-btn').click();
    await reviewMetadataResponse;
    await expect(page.locator('#status-bar')).toContainText('Synced 2 notifications');

    await page.locator('#view-others-prs').click();

    await expect(page.locator('#view-others-prs .count')).toHaveText('1');
    await expect(page.locator('#view-pr-notifications .count')).toHaveText('0');
    await expect(page.locator('#view-issues .count')).toHaveText('1');

    await page.locator('#view-others-prs').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="notif-pr-approved"]')).toBeVisible();

    await page.locator('#view-issues').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="notif-pr-external"]')).toBeVisible();
    await expect(page.locator('[data-id="notif-pr-approved"]')).not.toBeAttached();
  });
});
