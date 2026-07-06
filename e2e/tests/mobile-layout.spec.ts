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

test.describe('Mobile layout @layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

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

    await page.addInitScript(() => {
      localStorage.setItem('ghnotif_comment_expand_issues', 'true');
      localStorage.setItem('ghnotif_comment_hide_uninteresting', 'false');
    });
    await openNotificationsWithCommentCache(page, {
      commentCache,
      expectedCount: 1,
      notifications: notificationsResponse,
    });
    await expect(page.locator('#status-bar')).toContainText('Synced');
  });

  test('stacks meta and actions below the title', async ({ page }) => {
    const item = page.locator('.notification-item').first();
    await item.click({ position: { x: 8, y: 8 } });

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
    await page.locator('.notification-item').first().click({ position: { x: 8, y: 8 } });

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

  test('shows tab switchers instead of mobile dropdown filters', async ({ page }) => {
    await expect(page.locator('.mobile-filter-row')).toBeHidden();
    await expect(page.locator('.view-tabs')).toBeVisible();
    await expect(page.locator('#view-cleaned')).toBeVisible();
    await expect(page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="state"]')).toBeVisible();
    await expect(page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]')).toBeVisible();
    await expect(page.locator('#order-select')).toBeVisible();
    await expect(page.locator('#mobile-select-btn')).toBeVisible();

    const cleanedBox = await page.locator('#view-cleaned').boundingBox();
    expect(cleanedBox).not.toBeNull();
    expect(cleanedBox!.x).toBeGreaterThanOrEqual(0);
    expect(cleanedBox!.x + cleanedBox!.width).toBeLessThanOrEqual(375);
  });

  test('keeps mobile queue tabs on one row and wraps subfilter borders to options', async ({ page }) => {
    const viewTabs = page.locator('.view-tab');
    await expect(viewTabs).toHaveCount(4);

    const tabBoxes = await Promise.all(
      ['#view-issues', '#view-pr-notifications', '#view-others-prs', '#view-cleaned'].map((selector) =>
        page.locator(selector).boundingBox()
      )
    );
    for (const box of tabBoxes) {
      expect(box).not.toBeNull();
    }

    const safeTabBoxes = tabBoxes as NonNullable<(typeof tabBoxes)[number]>[];
    const firstTabY = safeTabBoxes[0].y;
    for (const box of safeTabBoxes) {
      expect(Math.abs(box.y - firstTabY)).toBeLessThanOrEqual(2);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }

    const notificationsBox = await page.locator('.notifications-container').boundingBox();
    const bookmarkFilterBox = await page
      .locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="bookmark"]')
      .boundingBox();
    const stateFilterBox = await page
      .locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="state"]')
      .boundingBox();

    expect(notificationsBox).not.toBeNull();
    expect(bookmarkFilterBox).not.toBeNull();
    expect(stateFilterBox).not.toBeNull();

    const safeNotificationsBox = notificationsBox!;
    const safeBookmarkFilterBox = bookmarkFilterBox!;
    const safeStateFilterBox = stateFilterBox!;

    expect(safeBookmarkFilterBox.width).toBeLessThan(safeNotificationsBox.width - 24);
    expect(safeStateFilterBox.width).toBeLessThan(safeNotificationsBox.width - 24);
    expect(safeStateFilterBox.y).toBeGreaterThan(safeBookmarkFilterBox.y);
  });

  test('toggles comments by tapping the entry but not the title link', async ({ page }) => {
    const item = page.locator('.notification-item').first();
    const title = item.locator('.notification-title');

    await title.evaluate((element) => {
      element.addEventListener('click', (event) => event.preventDefault());
    });
    await title.click();
    await expect(item.locator('.comment-item')).toHaveCount(0);

    await item.click({ position: { x: 8, y: 8 } });
    await expect(item.locator('.comment-item')).toContainText(
      'Please take a look at this.'
    );

    await item.click({ position: { x: 8, y: 8 } });
    await expect(item.locator('.comment-item')).toHaveCount(0);
  });
});
