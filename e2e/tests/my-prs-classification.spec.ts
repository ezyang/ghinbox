import { test, expect } from '@playwright/test';
import { addAuthCacheInitScript, clearAppStorage } from './storage-utils';
import {
  makeNotification,
  makeNotificationsResponse,
  mockDefaultApiRoutes,
  mockGraphqlReviewMetadata,
  mockNotificationsResponse,
  viewTab,
} from './app-fixture';

const fixture = makeNotificationsResponse([
  makeNotification({
    id: 'notif-issue-1',
    updated_at: '2024-12-27T11:30:00Z',
    subject: { title: 'Issue: flaky tests', type: 'Issue', number: 11 },
    actors: [
      { login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
    ],
  }),
  makeNotification({
    id: 'notif-pr-author',
    reason: 'author',
    updated_at: '2024-12-27T10:00:00Z',
    subject: { title: 'PR: add new endpoint', number: 12 },
    actors: [
      { login: 'reviewer', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' },
    ],
  }),
  makeNotification({
    id: 'notif-pr-comment',
    unread: false,
    reason: 'comment',
    updated_at: '2024-12-27T09:30:00Z',
    subject: { title: 'PR: improve docs', number: 13 },
    actors: [
      { login: 'testuser', avatar_url: 'https://avatars.githubusercontent.com/u/3?v=4' },
    ],
  }),
]);

test.describe('Feed and Reviews PR classification @classification', () => {
  test.beforeEach(async ({ page }) => {
    await addAuthCacheInitScript(page);
    await mockDefaultApiRoutes(page, { notifications: fixture });
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

    await viewTab(page, 'issues').click();
    await expect(page.locator('.notification-item')).toHaveCount(3);
    await expect(page.locator('[data-id="notif-pr-author"]')).toBeVisible();
    await expect(page.locator('[data-id="notif-pr-comment"]')).toBeVisible();

    await viewTab(page, 'pr-notifications').click();
    await expect(page.locator('.notification-item')).toHaveCount(0);
    await viewTab(page, 'others-prs').click();
    await expect(page.locator('.notification-item')).toHaveCount(0);
  });

  test('uses PR metadata for review queues without promoting generic PR comments', async ({ page }) => {
    const graphqlFixture = makeNotificationsResponse([
      makeNotification({
        id: 'notif-pr-approved',
        reason: 'approved',
        updated_at: '2024-12-27T09:00:00Z',
        subject: { title: 'PR: follow-up fix', number: 14 },
        actors: [
          { login: 'reviewer', avatar_url: 'https://avatars.githubusercontent.com/u/4?v=4' },
        ],
      }),
      makeNotification({
        id: 'notif-pr-external',
        reason: 'comment',
        updated_at: '2024-12-27T08:00:00Z',
        subject: { title: 'PR: external change', number: 15 },
        actors: [
          { login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/5?v=4' },
        ],
      }),
    ]);

    await mockNotificationsResponse(page, graphqlFixture);
    await mockGraphqlReviewMetadata(page, {
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

    await viewTab(page, 'others-prs').click();

    await expect(page.locator('#view-others-prs .count')).toHaveText('1');
    await expect(page.locator('#view-pr-notifications .count')).toHaveText('0');
    await expect(page.locator('#view-issues .count')).toHaveText('1');

    await viewTab(page, 'others-prs').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="notif-pr-approved"]')).toBeVisible();

    await viewTab(page, 'issues').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="notif-pr-external"]')).toBeVisible();
    await expect(page.locator('[data-id="notif-pr-approved"]')).not.toBeAttached();
  });
});
