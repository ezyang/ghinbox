import { test, expect } from '@playwright/test';
import { mockHtmlAction, openNotificationsWithCommentCache } from './app-fixture';

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
        title: 'Comment visibility check',
        url: 'https://github.com/test/repo/issues/1',
        type: 'Issue',
        number: 1,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: {
        saved: false,
        done: false,
        action_tokens: {
          archive: 'test-csrf-token',
          unarchive: 'test-csrf-token',
          subscribe: 'test-csrf-token',
          unsubscribe: 'test-csrf-token',
        },
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

test.describe('Comment visibility @layout', () => {
  test.beforeEach(async ({ page }) => {
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
              user: { login: 'dependabot[bot]' },
              body: 'Bumps deps',
              created_at: '2025-01-01T01:00:00Z',
              updated_at: '2025-01-01T01:00:00Z',
            },
            {
              id: 202,
              user: { login: 'human' },
              body: '@pytorchbot label feature',
              created_at: '2025-01-01T01:30:00Z',
              updated_at: '2025-01-01T01:30:00Z',
            },
            {
              id: 203,
              user: { login: 'human' },
              body: 'Please take a look at this.',
              created_at: '2025-01-01T02:00:00Z',
              updated_at: '2025-01-01T02:00:00Z',
            },
          ],
        },
      },
    };

    await page.addInitScript(() => {
      localStorage.setItem('ghnotif_comment_expand_issues', 'true');
      localStorage.setItem('ghnotif_comment_expand_prs', 'true');
      localStorage.setItem('ghnotif_comment_hide_uninteresting', 'false');
    });
    await openNotificationsWithCommentCache(page, {
      commentCache,
      expectedCount: 1,
      notifications: notificationsResponse,
    });
    await expect(page.locator('#status-bar')).toContainText('Synced');
  });

  test('hides uninteresting comments when enabled', async ({ page }) => {
    await expect(page.locator('.comment-item')).toHaveCount(3);
    await expect(page.locator('.comment-item').nth(0)).toContainText(
      'Bumps deps'
    );
    await expect(page.locator('.comment-item').nth(1)).toContainText(
      '@pytorchbot label feature'
    );
    await expect(page.locator('.comment-item').nth(2)).toContainText(
      'Please take a look at this.'
    );

    await page.locator('#comment-hide-uninteresting-toggle').check();

    await expect(page.locator('.comment-item')).toHaveCount(1);
    await expect(page.locator('.comment-item').first()).toContainText(
      'Please take a look at this.'
    );
  });

  test('shows bottom mark done button when comments are expanded', async ({
    page,
  }) => {
    await mockHtmlAction(page);

    const bottomDoneButton = page.locator('.notification-done-btn-bottom');
    await expect(bottomDoneButton).toBeVisible();

    await bottomDoneButton.click();

    await expect(page.locator('#status-bar')).toContainText(
      'Marked as done'
    );
    await expect(page.locator('.notification-item')).toHaveCount(0);
  });

  test('shows open in new tab button when comments are expanded', async ({
    page,
  }) => {
    const openButton = page.locator('.notification-open-btn-bottom');
    await expect(openButton).toBeVisible();

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      openButton.click(),
    ]);

    await expect(popup).toHaveURL('https://github.com/test/repo/issues/1');
    await popup.close();
  });

  test('uses GitHub-sized comment typography with a wider layout', async ({
    page,
  }) => {
    const commentBody = page.locator('.comment-body').first();
    await expect(commentBody).toBeVisible();

    const fontSize = await commentBody.evaluate((element) => {
      return window.getComputedStyle(element).fontSize;
    });
    expect(fontSize).toBe('14px');

    const container = page.locator('.container');
    const maxWidth = await container.evaluate((element) => {
      return window.getComputedStyle(element).maxWidth;
    });
    expect(maxWidth).toBe('1200px');
  });

  test('scales markdown images to fit the comment width', async ({ page }) => {
    await page.evaluate(() => {
      const body = document.querySelector('.comment-body.markdown-body');
      if (!body) {
        return;
      }
      const svg =
        "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'></svg>";
      const img = document.createElement('img');
      img.alt = 'markdown image';
      img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      body.appendChild(img);
    });

    const image = page.locator('.comment-body.markdown-body img').last();
    await expect(image).toBeVisible();
    const sizes = await image.evaluate((element) => {
      const img = element as HTMLImageElement;
      const container = img.closest('.comment-body.markdown-body') as HTMLElement | null;
      return {
        imgWidth: img.clientWidth,
        imgHeight: img.clientHeight,
        containerWidth: container?.clientWidth ?? 0,
      };
    });
    expect(sizes.imgWidth).toBeGreaterThan(0);
    expect(sizes.containerWidth).toBeGreaterThan(0);
    expect(sizes.imgWidth).toBeLessThanOrEqual(sizes.containerWidth + 1);
    expect(Math.abs(sizes.imgHeight - sizes.imgWidth * 0.75)).toBeLessThanOrEqual(2);
  });

  test('notification header has sticky positioning when comments are expanded', async ({
    page,
  }) => {
    const notificationHeader = page.locator('.notification-header').first();
    await expect(notificationHeader).toBeVisible();

    const position = await notificationHeader.evaluate((element) => {
      return window.getComputedStyle(element).position;
    });
    expect(position).toBe('sticky');

    const top = await notificationHeader.evaluate((element) => {
      return window.getComputedStyle(element).top;
    });
    expect(top).toBe('0px');
  });

  test('inline actions align with the sticky title row', async ({ page }) => {
    await page.evaluate(() => {
      const list = document.querySelector('.comment-list');
      const item = list?.querySelector('.comment-item');
      if (!list || !item) {
        return;
      }
      for (let i = 0; i < 12; i += 1) {
        list.appendChild(item.cloneNode(true));
      }
    });

    await page.locator('.comment-item').nth(10).scrollIntoViewIfNeeded();

    const positions = await page.evaluate(() => {
      const header = document.querySelector('.notification-header');
      const title = document.querySelector('.notification-title');
      const actions = document.querySelector('.notification-actions-inline');
      if (!header || !title || !actions) {
        return null;
      }
      return {
        headerTop: Math.round(header.getBoundingClientRect().top),
        titleTop: Math.round(title.getBoundingClientRect().top),
        actionsTop: Math.round(actions.getBoundingClientRect().top),
      };
    });

    expect(positions).not.toBeNull();
    expect(positions?.headerTop).toBeLessThanOrEqual(2);
    expect(Math.abs((positions?.actionsTop ?? 0) - (positions?.titleTop ?? 0)))
      .toBeLessThanOrEqual(1);
  });
});
