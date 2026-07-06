import { test, expect } from '@playwright/test';
import { openNotificationsWithSync } from './app-fixture';

const inlineCodeFixture = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: new Date().toISOString(),
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    {
      id: 'inline-code-pr',
      unread: true,
      reason: 'subscribed',
      updated_at: new Date().toISOString(),
      subject: {
        title:
          'autograd.function with `setup_context` has a number of issues with `torch.compile`',
        url: 'https://github.com/test/repo/pull/123',
        type: 'PullRequest',
        number: 123,
        state: 'open',
        state_reason: null,
      },
      actors: [],
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

test.describe('Inline Code Titles', () => {
  test.beforeEach(async ({ page }) => {
    await openNotificationsWithSync(page, {
      expectedCount: 1,
      notifications: inlineCodeFixture,
    });
    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');
  });

  test('renders backticks as inline code in PR titles', async ({ page }) => {
    const title = page.locator('.notification-title').first();
    await expect(title.locator('code')).toHaveCount(2);
    await expect(title.locator('code').nth(0)).toHaveText('setup_context');
    await expect(title.locator('code').nth(1)).toHaveText('torch.compile');
    await expect(title).toContainText(
      'autograd.function with setup_context has a number of issues with torch.compile'
    );
  });
});
