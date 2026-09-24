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

function reviewRequest(number: number, title: string) {
  return {
    ...makeNotification({
      id: `review-request:pytorch/pytorch#${number}`,
      repo: 'pytorch/pytorch',
      repository: { owner: 'pytorch', name: 'pytorch', full_name: 'pytorch/pytorch' },
      reason: 'review_requested',
      updated_at: '2025-01-05T12:00:00Z',
      subject: { type: 'PullRequest', title, number },
    }),
    responsibility_source: 'review-requested',
  };
}

async function triggerBackgroundRefresh(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

test.describe('Feed digest and background refresh @sync', () => {
  test.beforeEach(async ({ page }) => {
    await openCleanSyncPage(page);
  });

  test('Feed rows flag what is worth a look; the panel shows queue, vibe, and LLM usage', async ({
    page,
  }) => {
    const alpha = feedIssue('digest-alpha', 101, 'Alpha regression');
    const beta = feedIssue('digest-beta', 102, 'Beta design question');
    await mockProfileSnapshot(page, {
      get: profileSnapshot([alpha, beta], '2025-01-05T12:01:00+00:00'),
    });
    const digestServer = await mockDigest(
      page,
      makeDigestPayload({
        counts: { feed_count: 12, direct_count: 2, broadcast_count: 9 },
        queue_count: 12,
        llm_usage: {
          window_hours: 24,
          triage: { calls: 11 },
          compose: { calls: 1 },
          total: { calls: 12, errors: 0, input_tokens: 184000, output_tokens: 9500 },
        },
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
    // "Look at these" lives in the list itself.
    await expect(page.locator('[data-id="digest-alpha"] .notification-digest-why')).toHaveText(
      'alice asked you directly'
    );
    await expect(page.locator('[data-id="digest-alpha"]')).toHaveClass(/digest-worth-a-look/);
    await expect(page.locator('[data-id="digest-beta"] .notification-digest-why')).toHaveCount(0);
    await expect(page.locator('.notification-digest-why')).toHaveCount(1);
    await expect(panel.locator('.digest-status')).toContainText(
      '1 worth a look · 12 marked done, queued for the next digest · digest from just now'
    );
    await expect(panel.locator('.digest-usage')).toHaveText(
      'LLM, last 24h: 12 calls (11 triage, 1 compose) · 184k in / 10k out tokens'
    );
    await expect(panel.locator('.digest-look-at-empty')).toBeHidden();
    // Vibe prose is text, never HTML.
    await expect(panel.locator('.digest-vibe-theme')).toContainText(
      'Lots of <b>inductor</b> churn this week.'
    );
    await expect(panel.locator('.digest-vibe-theme a')).toHaveText('(pytorch#102)');

    await expect(panel.locator('.digest-open-all')).toHaveText('Open 1 worth a look');
    await panel.locator('.digest-open-all').click();
    await expect.poll(openedUrls).toEqual([alpha.subject.url]);

    await panel.locator('.digest-refresh').click();
    await expect.poll(() => digestServer.runCount).toBe(1);

    await viewTab(page, 'others-prs').click();
    await expect(panel).toBeHidden();
  });

  test('digest keeps vibe examples the server already marked done', async ({ page }) => {
    const surfaced = feedIssue('auto-surfaced', 401, 'Needs you');
    const autoDone = feedIssue('auto-done', 402, 'Ambient churn');
    await mockProfileSnapshot(page, {
      get: profileSnapshot([surfaced], '2025-01-05T12:01:00+00:00'),
    });
    await mockDigest(
      page,
      makeDigestPayload({
        counts: { feed_count: 9, direct_count: 0, broadcast_count: 7, auto_done_count: 8 },
        auto_done: { at: '2025-01-05T12:02:00+00:00', attempted: 3, done: 2, error: 'HTTP 500' },
        look_at: [digestItem(surfaced, 'worth a look')],
        vibe: [
          {
            title: 'Inductor',
            text: 'Quiet week.',
            examples: [digestItem(autoDone, '')],
          },
        ],
      })
    );
    await page.reload();

    const panel = page.locator('#digest-panel');
    await expect(page.locator('[data-id="auto-surfaced"] .notification-digest-why')).toHaveText(
      'worth a look'
    );
    await expect(panel.locator('.digest-vibe-theme a')).toHaveText('(pytorch#402)');
    await expect(page.locator('[data-id="auto-done"]')).toHaveCount(0);
    await expect(panel.locator('.digest-status')).toContainText('1 worth a look');
    await expect(panel.locator('.digest-usage')).toBeHidden();
    await expect(panel.locator('.digest-status')).toContainText('auto-done failed: HTTP 500');
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

  test('background pull does not undo a fresher Reviews reload', async ({ page }) => {
    const feed = feedIssue('bg-feed', 401, 'Feed item');
    const stale = reviewRequest(402, 'No longer requested');
    const pageLoadedAt = new Date().toISOString();
    let current = profileSnapshot([feed, stale], '2025-01-05T12:01:00+00:00');
    const server = await mockProfileSnapshot(page, { get: () => current });
    await mockDigest(page, makeDigestPayload({ enabled: false, composed_at: null }));
    await page.route('**/github/rest/review-requests**', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ notifications: [] }) })
    );
    await page.reload();

    // Entering Reviews reloads review requests live: the stale one is gone.
    await viewTab(page, 'others-prs').click();
    await expect(page.locator('#status-bar')).toContainText('Reloaded 0 review notifications');
    await expect(page.locator(`[data-id="${stale.id}"]`)).toHaveCount(0);

    // A server sync that began before that reload still lists it.
    current = profileSnapshot([feed, stale], new Date().toISOString(), {
      status: 'success',
      mode: 'full',
      started_at: pageLoadedAt,
    });
    const getsBefore = server.getCount;
    await triggerBackgroundRefresh(page);
    await expect.poll(() => server.getCount).toBeGreaterThan(getsBefore);
    await expect(page.locator(`[data-id="${stale.id}"]`)).toHaveCount(0, { timeout: 1200 });
  });
});
