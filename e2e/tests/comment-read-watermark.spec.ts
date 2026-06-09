import { test, expect } from '@playwright/test';
import { addAuthCacheInitScript } from './storage-utils';

function notification(updatedAt: string, ui: Record<string, unknown> = {}) {
  return {
    id: 'thread-watermark',
    unread: true,
    reason: 'comment',
    updated_at: updatedAt,
    last_read_at: '2025-01-01T00:00:00Z',
    subject: {
      title: 'Watermarked comments',
      url: 'https://github.com/test/repo/issues/7',
      type: 'Issue',
      number: 7,
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
      ...ui,
    },
  };
}

function responseFor(notificationPayload: ReturnType<typeof notification>) {
  return {
    source_url: 'https://github.com/notifications?query=repo:test/repo',
    generated_at: '2025-01-02T00:00:00Z',
    repository: {
      owner: 'test',
      name: 'repo',
      full_name: 'test/repo',
    },
    notifications: [notificationPayload],
    pagination: {
      before_cursor: null,
      after_cursor: null,
      has_previous: false,
      has_next: false,
    },
  };
}

test.describe('Read comment watermark @mutation', () => {
  test('marks done notifications with a persistent comment read watermark', async ({
    page,
  }) => {
    await addAuthCacheInitScript(page);
    await page.addInitScript(() => {
      localStorage.setItem('ghnotif_comment_expand_issues', 'true');
    });

    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rate: { limit: 5000, remaining: 4999, reset: 0 },
          resources: {},
        }),
      });
    });

    let notificationsResponse = responseFor(
      notification('2025-01-02T00:00:00Z')
    );
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(notificationsResponse),
      });
    });

    await page.route('**/notifications/html/action', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    });

    let savedWatermark: string | null = null;
    await page.route(
      '**/notifications/html/repo/test/repo/read-comment-watermarks/thread-watermark',
      async (route) => {
        const payload = route.request().postDataJSON() as {
          read_comment_watermark_at?: string;
        };
        savedWatermark = payload.read_comment_watermark_at || null;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'ok',
            repo: 'test/repo',
            notification_id: 'thread-watermark',
            read_comment_watermark_at: savedWatermark,
          }),
        });
      }
    );

    await page.route('**/github/rest/repos/test/repo/issues/7/comments', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 101,
            user: { login: 'reviewer' },
            body: 'Already read before Done',
            created_at: '2025-01-02T00:00:00Z',
            updated_at: '2025-01-02T00:00:00Z',
          },
        ]),
      });
    });

    let secondBulkLastReadAt: string | null = null;
    await page.route('**/github/rest/comments/bulk', async (route) => {
      const payload = route.request().postDataJSON() as {
        notifications?: Array<{
          last_read_at?: string | null;
          ui?: { read_comment_watermark_at?: string | null };
        }>;
      };
      const notification = payload.notifications?.[0];
      const lastReadAt =
        notification?.ui?.read_comment_watermark_at ?? notification?.last_read_at;
      if (lastReadAt === savedWatermark) {
        secondBulkLastReadAt = lastReadAt;
      }
      const comments =
        lastReadAt === savedWatermark
          ? [
              {
                id: 202,
                user: { login: 'reviewer' },
                body: 'Only this comment is after the watermark',
                created_at: '2025-01-03T00:00:00Z',
                updated_at: '2025-01-03T00:00:00Z',
              },
            ]
          : [
              {
                id: 101,
                user: { login: 'reviewer' },
                body: 'Already read before Done',
                created_at: '2025-01-02T00:00:00Z',
                updated_at: '2025-01-02T00:00:00Z',
              },
            ];
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          threads: {
            'thread-watermark': {
              comments,
              allComments: false,
            },
          },
        }),
      });
    });

    await page.goto('notifications.html');
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('.comment-item')).toContainText(
      'Already read before Done'
    );

    await page.locator('.notification-done-btn-bottom').click();
    await expect(page.locator('#status-bar')).toContainText('Marked as done');
    await expect.poll(() => savedWatermark).not.toBeNull();

    notificationsResponse = responseFor(
      notification('2025-01-03T00:00:00Z', {
        read_comment_watermark_at: savedWatermark,
      })
    );

    await page.locator('#sync-btn').click();

    await expect(page.locator('.comment-item')).toContainText(
      'Only this comment is after the watermark'
    );
    await expect(page.locator('.comment-item')).not.toContainText(
      'Already read before Done'
    );
    expect(secondBulkLastReadAt).toBe(savedWatermark);
  });
});
