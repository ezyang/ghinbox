import { test, expect, type Page } from '@playwright/test';
import {
  captureHtmlActions,
  captureOpenedWindows,
  makeCommentCache,
  makeCommentThread,
  makeDigestPayload,
  makeNotification,
  makeNotificationsResponse,
  makeProfileServerSnapshotPayload,
  mockDigest,
  mockProfileSnapshot,
  mockCollaboratorPermission,
  openCleanSyncPage,
  subfilterTab,
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

    await panel.locator('.digest-refresh').click();
    await expect.poll(() => digestServer.runCount).toBe(1);

    await viewTab(page, 'others-prs').click();
    await expect(panel).toBeHidden();
  });

  test('opening what is worth a look marks it done, with undo', async ({ page }) => {
    const alpha = feedIssue('open-alpha', 111, 'Alpha regression');
    const beta = feedIssue('open-beta', 112, 'Beta needs you too');
    const ambient = feedIssue('open-ambient', 113, 'Ambient churn');
    await mockProfileSnapshot(page, {
      get: profileSnapshot([alpha, beta, ambient], '2025-01-05T12:01:00+00:00'),
    });
    await mockDigest(
      page,
      makeDigestPayload({
        look_at: [digestItem(alpha, 'alice asked you'), digestItem(beta, 'bob replied')],
      })
    );
    const openedUrls = await captureOpenedWindows(page);
    const actions = await captureHtmlActions(page);
    await page.reload();

    const panel = page.locator('#digest-panel');
    await expect(panel.locator('.digest-open-all')).toHaveText('Open 2 worth a look');
    await panel.locator('.digest-open-all').click();
    await expect.poll(openedUrls).toEqual([alpha.subject.url, beta.subject.url]);
    await expect
      .poll(() => actions.map((action) => [action.action, action.notification_ids]))
      .toEqual([['archive', ['open-alpha', 'open-beta']]]);
    await expect(page.locator('[data-id="open-alpha"]')).toHaveCount(0);
    await expect(page.locator('[data-id="open-beta"]')).toHaveCount(0);
    await expect(page.locator('[data-id="open-ambient"]')).toBeVisible();
    // Handled: the panel has nothing left to open.
    await expect(panel.locator('.digest-open-all')).toBeHidden();
    await expect(panel.locator('.digest-look-at-empty')).toBeVisible();

    await page.keyboard.press('u');
    await expect(page.locator('[data-id="open-alpha"]')).toBeVisible();
    await expect(page.locator('[data-id="open-beta"]')).toBeVisible();
    await expect(panel.locator('.digest-open-all')).toHaveText('Open 2 worth a look');
  });

  test('Replies the digest judged FYI move to Feed until new activity', async ({ page }) => {
    const asks = feedIssue('reply-asks', 201, 'Question for you');
    const thanks = feedIssue('reply-thanks', 202, 'Thanks for the idea');
    const mentioned = (login: string, body: string, updatedAt = '2025-01-05T12:00:00Z') =>
      makeCommentThread({
        notificationUpdatedAt: updatedAt,
        lastReadAt: '2025-01-05T00:00:00Z',
        allComments: true,
        comments: [
          {
            id: login.length,
            created_at: '2025-01-05T11:00:00Z',
            updated_at: '2025-01-05T11:00:00Z',
            body,
            user: { login },
          },
        ],
      });
    const snapshot = (notifications: ReturnType<typeof feedIssue>[], syncedAt: string) =>
      makeProfileServerSnapshotPayload('pytorch', {
        snapshot: {
          notifications,
          comment_cache: makeCommentCache({
            'reply-asks': mentioned('alice', '@testuser can you take a look?'),
            'reply-thanks': mentioned(
              'bob',
              'Thanks @testuser, that worked.',
              notifications[1].updated_at
            ),
          }),
          authenticity_token: 'server-token',
          synced_at: syncedAt,
        },
        sync: { status: 'success', mode: 'full' },
      });
    let current = snapshot([asks, thanks], '2025-01-05T12:01:00+00:00');
    await mockProfileSnapshot(page, { get: () => current });
    await mockDigest(
      page,
      makeDigestPayload({
        reply_demotions: [
          { id: 'reply-thanks', updated_at: thanks.updated_at, why: 'just a thank-you' },
        ],
      })
    );
    await page.reload();

    await expect(page.locator('#digest-panel .digest-status')).toContainText(
      '1 reply judged FYI, moved to Feed'
    );
    await expect(page.locator('#view-issues .count')).toHaveText('1');
    await expect(page.locator('[data-id="reply-thanks"] .notification-reply-demoted')).toHaveText(
      'Not a reply: just a thank-you'
    );
    await viewTab(page, 'pr-notifications').click();
    await expect(page.locator('[data-id="reply-asks"]')).toBeVisible();
    await expect(page.locator('[data-id="reply-thanks"]')).toHaveCount(0);

    // New activity voids the verdict: back to Replies until it is re-judged.
    current = snapshot(
      [asks, { ...thanks, updated_at: '2025-01-06T12:00:00Z' }],
      '2025-01-06T12:01:00+00:00'
    );
    await triggerBackgroundRefresh(page);
    await expect(page.locator('[data-id="reply-thanks"]')).toBeVisible();
    await expect(page.locator('#view-issues .count')).toHaveText('0');
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

  test('External review requests show the digest verdict; "Worth a look" hides skips', async ({
    page,
  }) => {
    const external = (number: number, title: string) => ({
      ...reviewRequest(number, title),
      actors: [{ login: `outsider${number}` }],
      author_association: 'CONTRIBUTOR',
    });
    const easy = external(501, 'Fix fake tensor stride crash');
    const skipped = external(502, 'Refactor ROCm build flags');
    const unjudged = external(503, 'Brand new external PR');
    await mockProfileSnapshot(page, {
      get: profileSnapshot([easy, skipped, unjudged], '2025-01-05T12:01:00+00:00'),
    });
    await page.route('**/github/rest/review-requests**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ notifications: [easy, skipped, unjudged] }),
      })
    );
    await mockCollaboratorPermission(page, 'read', { repo: 'pytorch/pytorch' });
    // Comment fetches must succeed: a failed fetch leaves the author unknown.
    await page.route(/\/github\/rest\/repos\/pytorch\/pytorch\/(issues|pulls)\/50\d\//, (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' })
    );
    const pullMetadata = (number: number) => ({
      state: 'OPEN',
      isDraft: false,
      reviewDecision: null,
      authorAssociation: 'CONTRIBUTOR',
      additions: 3,
      deletions: 1,
      changedFiles: 1,
      author: { login: `outsider${number}` },
      labels: { nodes: [] },
    });
    await page.route('**/github/graphql', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: { limit: 5000, remaining: 4999, resetAt: '2026-01-02T01:00:00Z' },
            repository: {
              pr501: pullMetadata(501),
              pr502: pullMetadata(502),
              pr503: pullMetadata(503),
            },
          },
        }),
      })
    );
    await mockDigest(
      page,
      makeDigestPayload({
        review_assessments: [
          {
            pr: 'pytorch/pytorch#501',
            id: easy.id,
            verdict: 'look',
            buckets: ['easy', 'context'],
            why: 'Three-line fix with a test in fake_tensor.py',
          },
          {
            pr: 'pytorch/pytorch#502',
            id: skipped.id,
            verdict: 'skip',
            buckets: [],
            why: 'ROCm build tweak outside your areas',
          },
        ],
      })
    );
    await page.reload();

    await viewTab(page, 'others-prs').click();
    await expect(page.locator('#status-bar')).toContainText('Reloaded 3 review notifications');
    await subfilterTab(page, 'others-prs', 'external', 'author').click();
    const easyRow = page.locator(`[data-id="${easy.id}"]`);
    const skippedRow = page.locator(`[data-id="${skipped.id}"]`);
    const unjudgedRow = page.locator(`[data-id="${unjudged.id}"]`);
    await expect(easyRow.locator('.notification-review-verdict')).toHaveAttribute(
      'data-verdict',
      'look'
    );
    await expect(easyRow.locator('.review-bucket')).toHaveText([
      'Easy review',
      'You know this code',
    ]);
    await expect(easyRow.locator('.review-verdict-why')).toHaveText(
      'Three-line fix with a test in fake_tensor.py'
    );
    await expect(skippedRow.locator('.notification-review-verdict')).toHaveText(
      'Skip: ROCm build tweak outside your areas'
    );
    await expect(unjudgedRow).toBeVisible();
    await expect(unjudgedRow.locator('.notification-review-verdict')).toHaveCount(0);
    await expect(subfilterTab(page, 'others-prs', 'skip', 'verdict').locator('.count')).toHaveText(
      '1'
    );

    // Demote-only: the filter hides judged skips, never unjudged PRs.
    await subfilterTab(page, 'others-prs', 'look', 'verdict').click();
    await expect(skippedRow).toHaveCount(0);
    await expect(easyRow).toBeVisible();
    await expect(unjudgedRow).toBeVisible();
    await expect(page).toHaveURL(/others_prs_verdict=look/);
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
