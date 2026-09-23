import { test, expect, type Page } from '@playwright/test';
import {
  captureHtmlActions,
  captureOpenedWindows,
  makeCommentCache,
  makeDigestPayload,
  makeNotification,
  makeNotificationsResponse,
  makeProfileServerSnapshotPayload,
  mockDigest,
  mockProfileSnapshot,
  openCleanSyncPage,
  TEST_ACTION_TOKENS,
  viewTab,
} from './app-fixture';

function feedIssue(id: string, number: number, title: string) {
  return makeNotification({
    id,
    repo: 'pytorch/pytorch',
    repository: { owner: 'pytorch', name: 'pytorch', full_name: 'pytorch/pytorch' },
    reason: 'mention',
    updated_at: '2025-01-05T12:00:00Z',
    subject: { type: 'Issue', title, number },
  });
}

function profileSnapshot(
  notifications: ReturnType<typeof feedIssue>[],
  syncedAt: string,
  sync: Record<string, unknown> = { status: 'success', mode: 'full' }
) {
  return makeProfileServerSnapshotPayload('pytorch', {
    snapshot: {
      notifications,
      comment_cache: makeCommentCache({}),
      authenticity_token: 'server-token',
      synced_at: syncedAt,
    },
    sync,
  });
}

function digestItem(notification: ReturnType<typeof feedIssue>, why: string) {
  return {
    id: notification.id,
    title: notification.subject.title,
    url: notification.subject.url,
    repo: 'pytorch/pytorch',
    number: notification.subject.number,
    type: 'Issue',
    state: 'open',
    why,
  };
}

async function triggerBackgroundRefresh(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

test.describe('Feed digest and background refresh @sync', () => {
  test.beforeEach(async ({ page }) => {
    await openCleanSyncPage(page);
  });

  test('Feed shows the server digest, minus items already done', async ({ page }) => {
    const alpha = feedIssue('digest-alpha', 101, 'Alpha regression');
    const beta = feedIssue('digest-beta', 102, 'Beta design question');
    await mockProfileSnapshot(page, {
      get: profileSnapshot([alpha, beta], '2025-01-05T12:01:00+00:00'),
    });
    const digestServer = await mockDigest(
      page,
      makeDigestPayload({
        counts: { feed_count: 12, direct_count: 2, broadcast_count: 9 },
        look_at: [
          digestItem(alpha, 'alice asked you directly'),
          { ...digestItem(beta, 'hi'), id: 'already-done', title: 'Gone item' },
        ],
        vibe: [
          {
            title: 'Inductor',
            text: 'Lots of <b>inductor</b> churn this week.',
            examples: [digestItem(beta, '')],
          },
        ],
      })
    );
    const openedUrls = await captureOpenedWindows(page);
    await page.reload();

    const panel = page.locator('#digest-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.digest-item')).toHaveCount(1);
    await expect(panel.locator('.digest-item')).toContainText('Alpha regression');
    await expect(panel.locator('.digest-item')).toContainText('alice asked you directly');
    await expect(panel).not.toContainText('Gone item');
    await expect(panel.locator('.digest-status')).toContainText(
      '1 of 12 worth a look (2 direct, 9 broadcast cc)'
    );
    // Vibe prose is text, never HTML.
    await expect(panel.locator('.digest-vibe-theme')).toContainText(
      'Lots of <b>inductor</b> churn this week.'
    );
    await expect(panel.locator('.digest-vibe-theme a')).toHaveText('(pytorch#102)');

    await panel.locator('.digest-open-all').click();
    await expect.poll(openedUrls).toEqual([alpha.subject.url]);

    await panel.locator('.digest-refresh').click();
    await expect.poll(() => digestServer.runCount).toBe(1);

    await viewTab(page, 'others-prs').click();
    await expect(panel).toBeHidden();
  });

  test('digest panel stays hidden when the server has no digest', async ({ page }) => {
    await mockProfileSnapshot(page, {
      get: profileSnapshot([feedIssue('plain-1', 1, 'Plain')], '2025-01-05T12:01:00+00:00'),
    });
    const digestServer = await mockDigest(
      page,
      makeDigestPayload({ enabled: false, composed_at: null })
    );
    await page.reload();

    await expect(page.locator('[data-id="plain-1"]')).toBeVisible();
    await expect.poll(() => digestServer.getCount).toBeGreaterThan(0);
    await expect(page.locator('#digest-panel')).toBeHidden();
  });

  test('returning to the page pulls a newer server snapshot', async ({ page }) => {
    const first = feedIssue('bg-first', 201, 'First item');
    const second = feedIssue('bg-second', 202, 'Arrived in the background');
    let current = profileSnapshot([first], '2025-01-05T12:01:00+00:00');
    const server = await mockProfileSnapshot(page, { get: () => current });
    await mockDigest(page, makeDigestPayload({ enabled: false, composed_at: null }));
    await page.reload();
    await expect(page.locator('[data-id="bg-first"]')).toBeVisible();

    current = profileSnapshot([first, second], new Date().toISOString(), {
      status: 'success',
      mode: 'full',
      started_at: new Date().toISOString(),
    });
    await triggerBackgroundRefresh(page);

    await expect(page.locator('[data-id="bg-second"]')).toBeVisible();
    await expect(page.locator('#status-bar')).toContainText('Refreshed from server snapshot');
    expect(server.postCount).toBe(0);
  });

  test('background pull never resurrects an item marked done after the sync started', async ({
    page,
  }) => {
    const doneLater = feedIssue('bg-done', 301, 'Marked done locally');
    const keep = feedIssue('bg-keep', 302, 'Keep me');
    const fresh = feedIssue('bg-fresh', 303, 'Fresh item');
    const pageLoadedAt = new Date().toISOString();
    let current = profileSnapshot([doneLater, keep], '2025-01-05T12:01:00+00:00');
    const server = await mockProfileSnapshot(page, { get: () => current });
    await mockDigest(page, makeDigestPayload({ enabled: false, composed_at: null }));
    const actions = await captureHtmlActions(page);
    // Pre-done reload: the item is unchanged on GitHub with no new comments.
    await page.route('**/notifications/html/repo/pytorch/pytorch**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          makeNotificationsResponse([doneLater, keep], {
            authenticity_token: TEST_ACTION_TOKENS.archive,
          })
        ),
      })
    );
    await page.route('**/github/rest/repos/**/issues/**/comments**', (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' })
    );
    await page.reload();

    await page.locator('[data-id="bg-done"] .notification-done-btn').click();
    await expect(page.locator('[data-id="bg-done"]')).toHaveCount(0);
    await expect.poll(() => actions.map((action) => action.action)).toEqual(['archive']);
    await expect(page.locator('#status-bar')).toContainText('Marked as done');

    // This server sync began before the mark-done, so it still lists the item.
    current = profileSnapshot([doneLater, keep, fresh], new Date().toISOString(), {
      status: 'success',
      mode: 'full',
      started_at: pageLoadedAt,
    });
    const getsBefore = server.getCount;
    await triggerBackgroundRefresh(page);
    await expect.poll(() => server.getCount).toBeGreaterThan(getsBefore);
    await expect(page.locator('[data-id="bg-fresh"]')).toHaveCount(0, { timeout: 1200 });
    await expect(page.locator('[data-id="bg-done"]')).toHaveCount(0);

    // A sync that started after the mark-done is safe to apply.
    current = profileSnapshot([keep, fresh], new Date(Date.now() + 1000).toISOString(), {
      status: 'success',
      mode: 'full',
      started_at: new Date(Date.now() + 1000).toISOString(),
    });
    await triggerBackgroundRefresh(page);
    await expect(page.locator('[data-id="bg-fresh"]')).toBeVisible();
    await expect(page.locator('[data-id="bg-done"]')).toHaveCount(0);
  });
});
