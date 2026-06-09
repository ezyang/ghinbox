import { test, expect } from '@playwright/test';
import {
  captureHtmlActions,
  makeCommentCache,
  makeCommentThread,
  makeNotification,
  makeNotificationsResponse,
  mockGraphqlReviewMetadata,
  openNotificationsWithCommentCache,
  subfilterTab,
  TEST_ACTION_TOKENS,
  viewTab,
} from './app-fixture';

const needsReviewPr = makeNotification({
  id: 'thread-pr-1',
  reason: 'review_requested',
  last_read_at: '2025-01-01T00:00:00Z',
  subject: { title: 'Needs review PR', number: 1 },
  ui: { action_tokens: TEST_ACTION_TOKENS },
});

const approvedPr = makeNotification({
  id: 'thread-pr-2',
  reason: 'review_requested',
  updated_at: '2025-01-03T00:00:00Z',
  last_read_at: '2025-01-01T00:00:00Z',
  subject: { title: 'Approved PR', number: 2 },
  ui: { action_tokens: TEST_ACTION_TOKENS },
});

const approvedReview = {
  id: 101,
  state: 'APPROVED',
  submitted_at: '2025-01-02T12:00:00Z',
  user: { login: 'reviewer1' },
};

const baseCommentCache = makeCommentCache({
  'thread-pr-1': makeCommentThread({ reviewDecision: 'REVIEW_REQUIRED' }),
  'thread-pr-2': makeCommentThread({
    notificationUpdatedAt: approvedPr.updated_at,
    reviews: [approvedReview],
    reviewDecision: 'APPROVED',
  }),
});

function othersPrsStateTab(page: Parameters<typeof viewTab>[0], subfilter: string) {
  return subfilterTab(page, 'others-prs', subfilter, 'state');
}

test.describe('Triage queues @classification @mutation', () => {
  test.beforeEach(async ({ page }) => {
    await openNotificationsWithCommentCache(page, {
      notifications: makeNotificationsResponse([needsReviewPr, approvedPr]),
      commentCache: baseCommentCache,
      expectedCount: 2,
    });
  });

  test('routes open, non-approved PRs to needs review', async ({ page }) => {
    await viewTab(page, 'others-prs').click();

    await expect(othersPrsStateTab(page, 'needs-review').locator('.count')).toHaveText('1');
    await expect(othersPrsStateTab(page, 'approved').locator('.count')).toHaveText('1');

    await othersPrsStateTab(page, 'needs-review').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="thread-pr-1"]')).toBeVisible();
  });

  test('routes PRs approved by another reviewer out of needs review', async ({ page }) => {
    const approvedByOtherPr = makeNotification({
      id: 'thread-pr-approved-by-other',
      reason: 'review_requested',
      updated_at: '2025-01-04T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: { title: 'Approved by someone else', number: 3 },
      ui: { action_tokens: TEST_ACTION_TOKENS },
    });
    await openNotificationsWithCommentCache(page, {
      notifications: makeNotificationsResponse([needsReviewPr, approvedPr, approvedByOtherPr]),
      commentCache: makeCommentCache({
        ...baseCommentCache.threads,
        'thread-pr-approved-by-other': makeCommentThread({
          notificationUpdatedAt: approvedByOtherPr.updated_at,
          reviews: [
            {
              id: 301,
              state: 'APPROVED',
              submitted_at: '2025-01-03T12:00:00Z',
              user: { login: 'reviewer2' },
            },
          ],
          reviewDecision: 'REVIEW_REQUIRED',
        }),
      }),
      expectedCount: 3,
    });

    await viewTab(page, 'others-prs').click();
    await expect(othersPrsStateTab(page, 'needs-review').locator('.count')).toHaveText('1');
    await expect(othersPrsStateTab(page, 'approved').locator('.count')).toHaveText('2');

    await othersPrsStateTab(page, 'needs-review').click();
    await expect(page.locator('[data-id="thread-pr-approved-by-other"]')).not.toBeAttached();

    await othersPrsStateTab(page, 'approved').click();
    await expect(page.locator('[data-id="thread-pr-approved-by-other"]')).toBeVisible();
  });

  test('approved queue allows unsubscribe', async ({ page }) => {
    const actions = await captureHtmlActions(page);

    await viewTab(page, 'others-prs').click();
    await othersPrsStateTab(page, 'approved').click();
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();

    await page
      .locator('[data-id="thread-pr-2"] .notification-actions-inline .notification-unsubscribe-btn')
      .click();
    await expect(page.locator('[data-id="thread-pr-2"]')).not.toBeAttached();
    expect(actions.some((a) => a.action === 'unsubscribe')).toBe(true);
  });

  test('approved queue shows bottom unsubscribe when comments are expanded', async ({
    page,
  }) => {
    const actions = await captureHtmlActions(page);

    await page.locator('#comment-expand-prs-toggle').check();
    await viewTab(page, 'others-prs').click();
    await othersPrsStateTab(page, 'approved').click();
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();

    const bottomUnsubscribeButton = page.locator(
      '[data-id="thread-pr-2"] .notification-unsubscribe-btn-bottom'
    );
    await expect(bottomUnsubscribeButton).toBeVisible();

    await bottomUnsubscribeButton.click();

    await expect(page.locator('[data-id="thread-pr-2"]')).not.toBeAttached();
    expect(actions.some((a) => a.action === 'unsubscribe')).toBe(true);
  });

  test('approved queue shows Unsubscribe All button when nothing is selected', async ({
    page,
  }) => {
    await viewTab(page, 'others-prs').click();
    await othersPrsStateTab(page, 'approved').click();
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();

    // Button should be visible when nothing is selected
    const unsubscribeAllBtn = page.locator('#unsubscribe-all-btn');
    await expect(unsubscribeAllBtn).toBeVisible();
    await expect(unsubscribeAllBtn).toHaveText('Unsubscribe from all');

    // Button should be hidden when an item is selected
    await page.locator('[data-id="thread-pr-2"] .notification-checkbox').click();
    await expect(unsubscribeAllBtn).not.toBeVisible();

    // Button reappears when selection is cleared
    await page.locator('[data-id="thread-pr-2"] .notification-checkbox').click();
    await expect(unsubscribeAllBtn).toBeVisible();
  });

  test('approved queue action buttons are ordered and consistently named', async ({
    page,
  }) => {
    await viewTab(page, 'others-prs').click();
    await othersPrsStateTab(page, 'approved').click();
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();

    await expect(page.locator('#open-unread-btn')).toBeVisible();
    await expect(page.locator('#mark-done-btn')).toBeVisible();
    await expect(page.locator('#unsubscribe-all-btn')).toBeVisible();

    const actionLabels = await page
      .locator('#select-all-row button')
      .evaluateAll((buttons) =>
        buttons
          .filter((button) => {
            const style = window.getComputedStyle(button);
            return style.display !== 'none' && style.visibility !== 'hidden' && button.offsetParent !== null;
          })
          .map((button) => (button.textContent ?? '').trim())
          .filter(Boolean)
      );

    expect(actionLabels).toEqual([
      'Open all',
      'Mark all as done',
      'Unsubscribe from all',
    ]);
  });

  test('Unsubscribe All button unsubscribes all approved notifications', async ({ page }) => {
    const actions = await captureHtmlActions(page);

    await viewTab(page, 'others-prs').click();
    await othersPrsStateTab(page, 'approved').click();
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();

    await page.locator('#unsubscribe-all-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Unsubscribed from 1 notification');
    await expect(page.locator('[data-id="thread-pr-2"]')).not.toBeAttached();
    expect(actions.some((a) => a.action === 'unsubscribe')).toBe(true);
  });

  test('Unsubscribe All button is not visible in non-approved filters', async ({ page }) => {
    const unsubscribeAllBtn = page.locator('#unsubscribe-all-btn');

    // Not visible in Issues view (default)
    await expect(unsubscribeAllBtn).not.toBeVisible();

    await viewTab(page, 'others-prs').click();

    // Not visible in Needs Review subfilter (default for Others' PRs)
    await expect(unsubscribeAllBtn).not.toBeVisible();

    // Not visible in Done subfilter
    await othersPrsStateTab(page, 'done').click();
    await expect(unsubscribeAllBtn).not.toBeVisible();

    // Visible in Approved subfilter
    await othersPrsStateTab(page, 'approved').click();
    await expect(unsubscribeAllBtn).toBeVisible();
  });
});

test.describe('Triage queues GraphQL review decisions @classification', () => {
  test('approved queue uses GraphQL review decisions', async ({ page }) => {
    await openNotificationsWithCommentCache(page, {
      notifications: makeNotificationsResponse([needsReviewPr, approvedPr]),
      graphqlPrFields: {
        pr1: { reviewDecision: 'REVIEW_REQUIRED' },
        pr2: { reviewDecision: 'APPROVED' },
      },
      expectedCount: 2,
    });

    await viewTab(page, 'others-prs').click();

    await expect(othersPrsStateTab(page, 'approved').locator('.count')).toHaveText('1');
    await othersPrsStateTab(page, 'approved').click();

    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();
  });

  test('approval-required merge failures stay out of approved queue', async ({ page }) => {
    const unqualifiedApprovalPr = makeNotification({
      id: 'thread-pr-unqualified-approval',
      reason: 'review_requested',
      updated_at: '2025-01-04T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: { title: 'Approved by unqualified reviewer', number: 3 },
      ui: { action_tokens: TEST_ACTION_TOKENS },
    });
    await openNotificationsWithCommentCache(page, {
      notifications: makeNotificationsResponse([
        needsReviewPr,
        approvedPr,
        unqualifiedApprovalPr,
      ]),
      commentCache: makeCommentCache({
        ...baseCommentCache.threads,
        'thread-pr-unqualified-approval': makeCommentThread({
          notificationUpdatedAt: unqualifiedApprovalPr.updated_at,
          allComments: true,
          comments: [
            {
              id: 201,
              user: { login: 'pytorchmergebot' },
              body: [
                '## Merge failed',
                '**Reason**: Approvers from one of the following sets are needed:',
                '- superuser (pytorch/metamates)',
                '- Core Reviewers (mruberry, lezcano, Skylion007, ngimel, peterbell10, ...)',
                '- Core Maintainers (soumith, gchanan, ezyang, malfet, albanD, ...)',
              ].join('\n'),
              created_at: '2025-01-03T12:00:00Z',
              updated_at: '2025-01-03T12:00:00Z',
            },
          ],
          reviews: [
            {
              id: 202,
              state: 'APPROVED',
              submitted_at: '2025-01-03T11:00:00Z',
              user: { login: 'lakshayg' },
            },
          ],
          reviewDecision: 'APPROVED',
        }),
      }),
      expectedCount: 3,
    });

    await viewTab(page, 'others-prs').click();
    await expect(othersPrsStateTab(page, 'approved').locator('.count')).toHaveText('1');
    await expect(othersPrsStateTab(page, 'needs-review').locator('.count')).toHaveText('2');

    await othersPrsStateTab(page, 'approved').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();
    await expect(page.locator('[data-id="thread-pr-unqualified-approval"]')).not.toBeAttached();
  });

  test('approved filter excludes closed PRs', async ({ page }) => {
    const closedApprovedPr = makeNotification({
      id: 'thread-pr-closed-approved',
      reason: 'review_requested',
      updated_at: '2025-01-04T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: { title: 'Closed but approved PR', number: 3, state: 'closed' },
      ui: { action_tokens: TEST_ACTION_TOKENS },
    });
    await openNotificationsWithCommentCache(page, {
      notifications: makeNotificationsResponse([needsReviewPr, approvedPr, closedApprovedPr]),
      commentCache: makeCommentCache({
        ...baseCommentCache.threads,
        'thread-pr-closed-approved': makeCommentThread({
          notificationUpdatedAt: closedApprovedPr.updated_at,
          reviews: [
            {
              id: 102,
              state: 'APPROVED',
              submitted_at: '2025-01-03T12:00:00Z',
              user: { login: 'reviewer2' },
            },
          ],
          reviewDecision: 'APPROVED',
        }),
      }),
      expectedCount: 3,
    });

    await viewTab(page, 'others-prs').click();

    // Approved count should be 1 (only the open approved PR, not the closed one)
    await expect(othersPrsStateTab(page, 'approved').locator('.count')).toHaveText('1');
    await othersPrsStateTab(page, 'approved').click();

    // Only the open approved PR should be visible
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();
    await expect(page.locator('[data-id="thread-pr-closed-approved"]')).not.toBeAttached();
  });
});
