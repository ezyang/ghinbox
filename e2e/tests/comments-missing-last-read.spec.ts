import { test, expect } from '@playwright/test';
import {
  makeNotification,
  makeNotificationsResponse,
  mockDefaultApiRoutes,
} from './app-fixture';

test.describe('Comments without last_read_at', () => {
  test.beforeEach(async ({ page }) => {
    await mockDefaultApiRoutes(page);
  });

  test('loads full thread when last_read_at is missing', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('ghnotif_comment_expand_issues', 'true');
    });

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          makeNotificationsResponse(
            [
              makeNotification({
                id: 'notif-1',
                reason: 'comment',
                updated_at: '2025-01-02T00:00:00Z',
                subject: {
                  title: 'Missing last_read_at',
                  type: 'Issue',
                  number: 42,
                },
                actors: [
                  {
                    login: 'alice',
                    avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
                  },
                ],
              }),
            ],
            { generated_at: '2025-01-02T00:00:00Z' }
          )
        ),
      });
    });

    await page.route('**/github/rest/notifications**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    let issueCalled = false;
    await page.route('**/github/rest/repos/test/repo/issues/42', (route) => {
      issueCalled = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 42,
          number: 42,
          user: { login: 'alice' },
          body: 'Initial issue post',
          created_at: '2024-12-31T00:00:00Z',
          updated_at: '2024-12-31T00:00:00Z',
        }),
      });
    });

    let commentUrl = '';
    await page.route(
      '**/github/rest/repos/test/repo/issues/42/comments**',
      (route) => {
        commentUrl = route.request().url();
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 1001,
              user: { login: 'bob' },
              body: 'Followup comment',
              created_at: '2025-01-01T00:00:00Z',
              updated_at: '2025-01-01T00:00:00Z',
            },
          ]),
        });
      }
    );

    await page.goto('notifications.html');
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');
    const commentItems = page.locator('.comment-item');
    await expect(commentItems).toHaveCount(2);
    await expect(commentItems.first()).toContainText('Initial issue post');
    await expect(commentItems.nth(1)).toContainText('Followup comment');
    expect(issueCalled).toBe(true);
    expect(commentUrl).not.toContain('since=');
  });
});
