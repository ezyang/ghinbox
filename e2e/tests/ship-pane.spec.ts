import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  captureIssueCommentPosts,
  capturePullRequestPatches,
  mockShipGraphql,
  openNotificationsWithCachedData,
  viewTab,
} from './app-fixture';

// Dr. CI comments harvested from pytorch/pytorch (scripts/harvest_ship_fixtures.py).
function drci(name: string) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'ship', `${name}.md`), 'utf8');
}

function stackBody(numbers: number[], current: number) {
  return [
    'Stack from [ghstack](https://github.com/ezyang/ghstack/tree/0.18.0) (oldest at bottom):',
    ...numbers.map((number) => (number === current ? `* __->__ #${number}` : `* #${number}`)),
    '',
    'Body.',
  ].join('\n');
}

// GraphQL node matching the ShipPullRequest fragment. Head SHAs stay null so
// the harvested Dr. CI comments are never treated as stale.
function prNode({
  number,
  title,
  updatedAt,
  reviewDecision = null,
  merged = false,
  body = '',
  drciComment = null,
  tail = [],
}: {
  number: number;
  title: string;
  updatedAt: string;
  reviewDecision?: string | null;
  merged?: boolean;
  body?: string;
  drciComment?: string | null;
  tail?: Array<{ author: { login: string }; body: string; createdAt: string }>;
}) {
  return {
    number,
    title,
    url: `https://github.com/pytorch/pytorch/pull/${number}`,
    state: merged ? 'MERGED' : 'OPEN',
    merged,
    isDraft: false,
    updatedAt,
    mergeable: 'MERGEABLE',
    reviewDecision,
    body,
    repository: { nameWithOwner: 'pytorch/pytorch' },
    labels: { nodes: [{ name: 'topic: not user facing' }] },
    reviewRequests: { totalCount: 1 },
    latestOpinionatedReviews: { nodes: [] },
    commits: {
      nodes: [{
        commit: { oid: null, committedDate: '2026-10-08T00:00:00Z', statusCheckRollup: { state: 'FAILURE' } },
      }],
    },
    headComments: {
      nodes: drciComment
        ? [{ author: { login: 'pytorch-bot' }, body: drciComment, createdAt: '2026-10-08T00:10:00Z' }]
        : [],
    },
    tailComments: { nodes: tail },
  };
}

const STACK = [503, 502, 501, 500];

// Stack 503 > 502 > 501 > 500(merged, outside the search): 501 is approved
// with a new failure, 502 awaits review, so 503 must wait.
const SEARCH_NODES = [
  prNode({
    number: 503,
    title: 'Top of stack',
    updatedAt: '2026-10-08T10:00:00Z',
    reviewDecision: 'APPROVED',
    body: stackBody(STACK, 503),
    drciComment: drci('drci-no-failures'),
  }),
  prNode({
    number: 502,
    title: 'Middle of stack',
    updatedAt: '2026-10-08T09:30:00Z',
    body: stackBody(STACK, 502),
    drciComment: drci('drci-no-failures'),
  }),
  prNode({
    number: 501,
    title: 'Bottom of stack',
    updatedAt: '2026-10-08T09:00:00Z',
    reviewDecision: 'APPROVED',
    body: stackBody(STACK, 501),
    drciComment: drci('drci-new-failure'),
  }),
  prNode({
    number: 600,
    title: 'Approved and green',
    updatedAt: '2026-10-08T08:00:00Z',
    reviewDecision: 'APPROVED',
    drciComment: drci('drci-merge-normally-flaky'),
  }),
  prNode({
    number: 700,
    title: 'Waiting on reviewers',
    updatedAt: '2026-10-08T07:00:00Z',
    drciComment: drci('drci-pending'),
  }),
  prNode({
    number: 800,
    title: 'Changes requested',
    updatedAt: '2026-10-08T06:00:00Z',
    reviewDecision: 'CHANGES_REQUESTED',
    drciComment: drci('drci-no-failures'),
  }),
  prNode({
    number: 900,
    title: 'Merge tripped on a flaky job',
    updatedAt: '2026-10-08T05:00:00Z',
    reviewDecision: 'APPROVED',
    // Dr. CI later called the job mergebot failed on FLAKY.
    drciComment: drci('drci-merge-normally-flaky').replace('test (default, 7, 8,', 'test (default, 2, 8,'),
    tail: [{ author: { login: 'pytorchmergebot' }, body: drci('mergebot-failed-job'), createdAt: '2026-10-08T05:00:00Z' }],
  }),
];

const STACK_NODES = {
  pr500: prNode({
    number: 500,
    title: 'Already landed',
    updatedAt: '2026-10-01T00:00:00Z',
    merged: true,
    body: stackBody(STACK, 500),
  }),
};

function shipRow(page: import('@playwright/test').Page, number: number) {
  return page.locator(`.ship-row[data-pr-key="pytorch/pytorch#${number}"]`);
}

test.describe('Ship pane @mutation', () => {
  test('splits my PRs by stack and ships with mergebot, acking failures', async ({ page }) => {
    await openNotificationsWithCachedData(page);
    const searches = await mockShipGraphql(page, { searchNodes: SEARCH_NODES, stackNodes: STACK_NODES });
    const posts = await captureIssueCommentPosts(page);

    await expect(viewTab(page, 'ship')).toContainText('PRs');
    await viewTab(page, 'ship').click();

    const action = page.locator('.ship-section[data-section="action"]');
    const review = page.locator('.ship-section[data-section="review"]');
    const landing = page.locator('.ship-section[data-section="landing"]');
    await expect(action.locator('.ship-group')).toHaveCount(4);
    expect(searches[0]).toMatch(/^is:pr is:open author:@me archived:false draft:false updated:>=/);
    await expect(viewTab(page, 'ship').locator('.count')).toHaveText('4');
    await expect(landing.locator('.ship-empty')).toHaveText('Nothing is landing.');
    await expect(page.locator('#notifications-list .notification-item')).toHaveCount(0);
    await expect(page.locator('#empty-state')).toBeHidden();
    await expect(page.locator('#select-all-row')).toBeHidden();
    await expect(page.locator('#bottom-actions-row')).toBeHidden();

    // The stack splits by row, newest first; the merged base is hidden.
    const stack = action.locator('.ship-group').first();
    await expect(stack).toHaveAttribute('data-stack', 'true');
    await expect(stack.locator('.ship-pr-link')).toHaveText(['pytorch#501']);
    await expect(stack.locator('.ship-stack-label')).toHaveText('Stack · 1 of 3 open PRs');
    const waitingStack = review.locator('.ship-group[data-stack="true"]');
    await expect(waitingStack.locator('.ship-pr-link')).toHaveText(['pytorch#503', 'pytorch#502']);
    // Approved but blocked lower in the stack: a greyed-out Ship Stacked.
    const blockedShip = shipRow(page, 503).locator('.ship-it-btn');
    await expect(blockedShip).toHaveText('Ship Stacked');
    await expect(blockedShip).toBeDisabled();
    await expect(blockedShip).toHaveAttribute('data-blocked', 'true');
    await expect(shipRow(page, 503)).toContainText('Approved; waiting on #502 (awaiting review)');
    await expect(shipRow(page, 502).locator('.ship-it-btn')).toHaveCount(0);
    await expect(shipRow(page, 501).locator('.ship-ci')).toHaveText('1 blocking failure');
    await expect(shipRow(page, 501).locator('.ship-it-btn')).toHaveText('Ship It (1 error)');
    await expect(shipRow(page, 800)).toContainText('Changes requested');
    await expect(review.locator('.ship-row')).toHaveCount(3);
    await expect(shipRow(page, 700)).toContainText('Awaiting review');
    await expect(shipRow(page, 700).locator('.ship-ci')).toHaveText('CI pending (1)');

    // Clean ship: Dr. CI's flaky failure is unrelated, so no prompt.
    await expect(shipRow(page, 600).locator('.ship-ci')).toHaveText('CI green');
    const unrelated = shipRow(page, 600).locator('.ship-ci-unrelated');
    await expect(unrelated).toHaveText('1 unrelated failure (FLAKY)');
    await expect(unrelated).toHaveCSS('color', 'rgb(154, 103, 0)');

    // A merge that failed on a now-FLAKY job is a yellow warning, not red.
    const flakyReason = shipRow(page, 900).locator('.ship-reason');
    await expect(flakyReason).toHaveText('Merge failed on a job Dr. CI now marks FLAKY');
    await expect(flakyReason).toHaveAttribute('data-severity', 'warning');
    await expect(flakyReason).toHaveCSS('color', 'rgb(154, 103, 0)');

    await shipRow(page, 600).locator('.ship-it-btn').click();
    await expect.poll(() => posts).toEqual([{ target: 'pytorch/pytorch#600', body: '@pytorchbot merge' }]);
    await expect(landing.locator(`.ship-row[data-pr-key="pytorch/pytorch#600"]`)).toContainText('Merge requested');
    await expect(viewTab(page, 'ship').locator('.count')).toHaveText('3');

    // Shipping over a blocking failure needs every failure acknowledged.
    await shipRow(page, 501).locator('.ship-it-btn').click();
    const dialog = page.locator('#ship-ack-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.ship-ack-command')).toHaveText('@pytorchbot merge -i');
    await expect(dialog.locator('.ship-ack-item')).toHaveCount(1);
    await expect(dialog.locator('.ship-ack-item label')).toContainText('#501: NEW FAILURE (1 job)');
    const confirm = dialog.locator('.ship-ack-confirm');
    await expect(confirm).toBeDisabled();
    await dialog.locator('.ship-ack-check').check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => posts.at(-1)).toEqual({
      target: 'pytorch/pytorch#501',
      body: '@pytorchbot merge -i',
    });
    await expect(landing.locator(`.ship-row[data-pr-key="pytorch/pytorch#501"]`)).toContainText('Merge requested');
    await expect(shipRow(page, 503)).toContainText('Approved; waiting on #502 (awaiting review), #501 (landing)');
  });

  test('Abandon in the … menu closes the PR at once, with Undo to reopen it', async ({ page }) => {
    await openNotificationsWithCachedData(page);
    await mockShipGraphql(page, { searchNodes: SEARCH_NODES, stackNodes: STACK_NODES });
    const patches = await capturePullRequestPatches(page);
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    await viewTab(page, 'ship').click();
    const row = shipRow(page, 800);
    const more = row.locator('.ship-more-btn');
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(row.locator('.ship-menu [role="menuitem"]')).toHaveText(['Abandon']);

    // Clicking elsewhere closes the menu.
    await page.locator('.ship-header').click();
    await expect(row.locator('.ship-menu')).toHaveCount(0);

    // Tucked behind the menu, Abandon needs no confirm.
    await more.click();
    await row.locator('.ship-abandon-btn').click();
    await expect.poll(() => patches).toEqual([{ target: 'pytorch/pytorch#800', body: { state: 'closed' } }]);
    await expect(row).toHaveCount(0);
    await expect(viewTab(page, 'ship').locator('.count')).toHaveText('3');
    const undo = page.locator('.ship-undo');
    await expect(undo).toContainText('Abandoned #800 Changes requested');

    await undo.locator('.ship-undo-btn').click();
    await expect.poll(() => patches.at(-1)).toEqual({ target: 'pytorch/pytorch#800', body: { state: 'open' } });
    await expect(row).toBeVisible();
    await expect(undo).toHaveCount(0);
    await expect(viewTab(page, 'ship').locator('.count')).toHaveText('4');
    expect(dialogs).toEqual([]);
  });

  test('a stack too deep for CI reads as CI not run, not red failures', async ({ page }) => {
    await openNotificationsWithCachedData(page);
    await mockShipGraphql(page, {
      searchNodes: [prNode({
        number: 1000,
        title: 'Deep in the stack',
        updatedAt: '2026-10-08T10:00:00Z',
        reviewDecision: 'APPROVED',
        drciComment: drci('drci-stack-too-deep'),
      })],
      stackNodes: {},
    });

    await viewTab(page, 'ship').click();
    const row = shipRow(page, 1000);
    await expect(row.locator('.ship-ci')).toHaveText('CI not run (stack too deep)');
    await expect(row.locator('.ship-ci')).toHaveAttribute('data-ci-state', 'not-run');
    const reason = row.locator('.ship-reason');
    await expect(reason).toHaveText("CI won't run with 10+ PRs below; land some, then re-push");
    await expect(reason).toHaveAttribute('data-severity', 'warning');
    await expect(row.locator('.ship-it-btn')).toHaveCount(0);
  });

  test('a page reload shows the last load at once while GitHub revalidates', async ({ page }) => {
    await openNotificationsWithCachedData(page);
    const searches = await mockShipGraphql(page, { searchNodes: SEARCH_NODES, stackNodes: STACK_NODES });
    await viewTab(page, 'ship').click();
    await expect(shipRow(page, 600).locator('.ship-it-btn')).toBeEnabled();
    expect(searches).toHaveLength(1);

    // Hold the next GitHub load so the cached render is observable.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/github/graphql', async (route) => {
      await held;
      await route.fallback();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('#ship-panel')).toBeVisible();
    await expect(shipRow(page, 600)).toBeVisible();
    await expect(viewTab(page, 'ship').locator('.count')).toHaveText('4');
    await expect(page.locator('.ship-status')).toContainText('refreshing…');
    // Cached rows can be stale, so Ship It waits for GitHub.
    await expect(shipRow(page, 600).locator('.ship-it-btn')).toBeDisabled();

    release();
    await expect(shipRow(page, 600).locator('.ship-it-btn')).toBeEnabled();
    await expect(page.locator('.ship-status')).not.toContainText('refreshing…');
    expect(searches).toHaveLength(2);
  });

  test('cancelling the acknowledgement posts nothing', async ({ page }) => {
    await openNotificationsWithCachedData(page);
    await mockShipGraphql(page, { searchNodes: SEARCH_NODES, stackNodes: STACK_NODES });
    const posts = await captureIssueCommentPosts(page);

    await viewTab(page, 'ship').click();
    await shipRow(page, 501).locator('.ship-it-btn').click();
    const dialog = page.locator('#ship-ack-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(shipRow(page, 501).locator('.ship-it-btn')).toHaveText('Ship It (1 error)');
    expect(posts).toEqual([]);
  });
});
