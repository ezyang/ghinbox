import { test, expect } from '@playwright/test';
import { clearAppStorage, seedCommentCache } from './storage-utils';

const notificationsResponse = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2025-01-02T00:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    {
      id: 'thread-1',
      unread: true,
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Mobile layout spacing check',
        url: 'https://github.com/test/repo/issues/1',
        type: 'Issue',
        number: 1,
        state: 'open',
        state_reason: null,
      },
      actors: [{ login: 'reviewer', avatar_url: 'https://avatars.githubusercontent.com/u/7?v=4' }],
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

test.describe('Mobile layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rate: { limit: 5000, remaining: 4999, reset: 0 },
          resources: {},
        }),
      });
    });

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(notificationsResponse),
      });
    });

    const commentCache = {
      version: 1,
      threads: {
        'thread-1': {
          notificationUpdatedAt: notificationsResponse.notifications[0].updated_at,
          lastReadAt: notificationsResponse.notifications[0].last_read_at,
          unread: true,
          allComments: false,
          fetchedAt: new Date().toISOString(),
          comments: [
            {
              id: 201,
              user: { login: 'human' },
              body: 'Please take a look at this.',
              created_at: '2025-01-01T02:00:00Z',
              updated_at: '2025-01-01T02:00:00Z',
            },
          ],
        },
      },
    };

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await page.evaluate(() => {
      localStorage.setItem('ghnotif_comment_expand_issues', 'true');
      localStorage.setItem('ghnotif_comment_hide_uninteresting', 'false');
    });
    await seedCommentCache(page, commentCache);
    await page.reload();

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced');
  });

  test('stacks meta and actions below the title', async ({ page }) => {
    const item = page.locator('.notification-item').first();
    const icon = item.locator('.notification-icon');
    const title = item.locator('.notification-title');
    const meta = item.locator('.notification-meta');
    const actions = item.locator('.notification-actions-inline');
    const commentList = item.locator('.comment-list');

    const [
      iconBox,
      titleBox,
      metaBox,
      actionsBox,
      commentListBox,
    ] = await Promise.all([
      icon.boundingBox(),
      title.boundingBox(),
      meta.boundingBox(),
      actions.boundingBox(),
      commentList.boundingBox(),
    ]);

    expect(iconBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(metaBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(commentListBox).not.toBeNull();

    const safeIconBox = iconBox!;
    const safeTitleBox = titleBox!;
    const safeMetaBox = metaBox!;
    const safeActionsBox = actionsBox!;
    const safeCommentListBox = commentListBox!;
    const titleBottom = safeTitleBox.y + safeTitleBox.height - 1;

    // Icon and title should be on the same row
    expect(safeTitleBox.x).toBeGreaterThan(safeIconBox.x);
    expect(safeTitleBox.x - safeIconBox.x).toBeLessThanOrEqual(40);
    // Meta and actions should be below the title
    expect(safeMetaBox.y).toBeGreaterThanOrEqual(titleBottom);
    expect(safeActionsBox.y).toBeGreaterThanOrEqual(titleBottom);
    // Comments should be below the actions
    expect(safeCommentListBox.y).toBeGreaterThanOrEqual(safeActionsBox.y);
    // Actors are hidden on mobile (display: none)
  });

  test('avoids horizontal scroll and uses full comment width', async ({ page }) => {
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);

    const item = page.locator('.notification-item').first();
    const commentItem = page.locator('.comment-item').first();
    const [itemBox, commentBox] = await Promise.all([
      item.boundingBox(),
      commentItem.boundingBox(),
    ]);

    expect(itemBox).not.toBeNull();
    expect(commentBox).not.toBeNull();

    const safeItemBox = itemBox!;
    const safeCommentBox = commentBox!;
    const leftGap = safeCommentBox.x - safeItemBox.x;
    const rightGap =
      safeItemBox.x + safeItemBox.width - (safeCommentBox.x + safeCommentBox.width);

    expect(leftGap).toBeLessThanOrEqual(16);
    expect(rightGap).toBeLessThanOrEqual(16);
  });
});
