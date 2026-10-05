import { test, expect } from '@playwright/test';
import {
  makeCommentCache,
  makeDigestPayload,
  makeNotification,
  makeProfileServerSnapshotPayload,
  mockCollaboratorPermission,
  mockDigest,
  mockProfileSnapshot,
  openCleanSyncPage,
  subfilterTab,
  viewTab,
} from './app-fixture';

/**
 * PyTorch's PR workflow (CONTRIBUTING.md, "PR lifecycle") labels each PR with
 * whose turn it is. Reviews follows those labels on pytorch/pytorch.
 */

function externalReviewRequest(number: number, title: string, labels: string[]) {
  return {
    ...makeNotification({
      id: `review-request:pytorch/pytorch#${number}`,
      repo: 'pytorch/pytorch',
      repository: { owner: 'pytorch', name: 'pytorch', full_name: 'pytorch/pytorch' },
      reason: 'review_requested',
      updated_at: '2025-01-05T12:00:00Z',
      subject: { type: 'PullRequest', title, number },
      actors: [{ login: `outsider${number}` }],
    }),
    responsibility_source: 'review-requested',
    author_association: 'CONTRIBUTOR',
    labels: labels.map((name) => ({ name })),
  };
}

test.describe('Reviews follow PyTorch workflow labels @classification', () => {
  test.beforeEach(async ({ page }) => {
    await openCleanSyncPage(page);
  });

  test('ready for review is Important; author-turn labels leave Reviews', async ({ page }) => {
    const ready = externalReviewRequest(601, 'Passed pre-review', ['triaged', 'ready for review']);
    const untriaged = externalReviewRequest(602, 'Not pre-reviewed yet', ['triaged']);
    const inProgress = externalReviewRequest(603, 'Author iterating', ['in progress']);
    const missing = externalReviewRequest(604, 'No actionable issue', [
      'missing actionable issue',
    ]);
    const requests = [ready, untriaged, inProgress, missing];
    await mockProfileSnapshot(page, {
      get: makeProfileServerSnapshotPayload('pytorch', {
        snapshot: {
          notifications: requests,
          comment_cache: makeCommentCache({}),
          authenticity_token: 'server-token',
          synced_at: '2025-01-05T12:01:00+00:00',
        },
        sync: { status: 'success', mode: 'full' },
      }),
    });
    await page.route('**/github/rest/review-requests**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ notifications: requests }),
      })
    );
    await mockCollaboratorPermission(page, 'read', { repo: 'pytorch/pytorch' });
    await page.route(/\/github\/rest\/repos\/pytorch\/pytorch\/(issues|pulls)\/60\d\//, (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' })
    );
    const pullMetadata = (request: (typeof requests)[number]) => ({
      state: 'OPEN',
      isDraft: false,
      reviewDecision: null,
      authorAssociation: 'CONTRIBUTOR',
      additions: 3,
      deletions: 1,
      changedFiles: 1,
      author: { login: `outsider${request.subject.number}` },
      labels: { nodes: request.labels },
    });
    await page.route('**/github/graphql', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: { limit: 5000, remaining: 4999, resetAt: '2026-01-02T01:00:00Z' },
            repository: Object.fromEntries(
              requests.map((request) => [`pr${request.subject.number}`, pullMetadata(request)])
            ),
          },
        }),
      })
    );
    // A "skip" from before pre-review must not hide the ready PR.
    await mockDigest(
      page,
      makeDigestPayload({
        review_assessments: [
          {
            pr: 'pytorch/pytorch#601',
            id: ready.id,
            verdict: 'skip',
            buckets: [],
            why: 'Judged before pre-review',
          },
        ],
      })
    );
    await page.reload();

    await viewTab(page, 'others-prs').click();
    await expect(page.locator('#status-bar')).toContainText('Reloaded 2 review notifications');
    const readyRow = page.locator(`[data-id="${ready.id}"]`);
    const untriagedRow = page.locator(`[data-id="${untriaged.id}"]`);
    await expect(readyRow).toBeVisible();
    await expect(untriagedRow).toBeVisible();
    await expect(page.locator(`[data-id="${inProgress.id}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-id="${missing.id}"]`)).toHaveCount(0);
    await expect(page.locator('#view-others-prs .count')).toHaveText('2');
    await expect(readyRow.locator('.notification-review-verdict')).toHaveCount(0);

    await subfilterTab(page, 'others-prs', 'committer', 'author').click();
    await expect(readyRow).toBeVisible();
    await expect(untriagedRow).toHaveCount(0);

    await subfilterTab(page, 'others-prs', 'external', 'author').click();
    await expect(untriagedRow).toBeVisible();
    await expect(readyRow).toHaveCount(0);
  });
});
