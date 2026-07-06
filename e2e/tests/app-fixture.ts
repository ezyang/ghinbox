import { expect, type Page, type Route } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import {
  addAuthCacheInitScript,
  APP_STORAGE_KEYS,
  clearAppStorage,
  readNotificationsCache,
  seedAuthCache,
  seedCommentCache,
  seedNotificationsCache,
  seedRepoSelection,
} from './storage-utils';

type JsonBody = unknown;
type RouteHandler = Parameters<Page['route']>[1];

const DEFAULT_REPO = 'test/repo';
const DEFAULT_LOGIN = 'testuser';

export const TEST_ACTION_TOKENS = {
  archive: 'test-csrf-token',
  unarchive: 'test-csrf-token',
  subscribe: 'test-csrf-token',
  unsubscribe: 'test-csrf-token',
} as const;

type NotificationOverrides = {
  id: string;
  subject?: Record<string, unknown>;
  ui?: Record<string, unknown>;
  [key: string]: unknown;
};

export function makeNotification({ id, subject = {}, ui = {}, ...rest }: NotificationOverrides) {
  const number = (subject.number as number) ?? 1;
  const type = (subject.type as string) ?? 'PullRequest';
  const urlPath = type === 'Issue' ? 'issues' : 'pull';
  return {
    id,
    unread: true,
    reason: 'subscribed',
    updated_at: '2025-01-02T00:00:00Z',
    actors: [],
    ...rest,
    subject: {
      title: `${type} #${number}`,
      url: `https://github.com/${DEFAULT_REPO}/${urlPath}/${number}`,
      type,
      number,
      state: 'open',
      state_reason: null,
      ...subject,
    },
    ui: { saved: false, done: false, ...ui },
  };
}

export function makeNotificationsResponse(
  notifications: unknown[],
  overrides: Record<string, unknown> = {}
) {
  const [owner, name] = DEFAULT_REPO.split('/');
  return {
    source_url: `https://github.com/notifications?query=repo:${DEFAULT_REPO}`,
    generated_at: '2025-01-02T00:00:00Z',
    repository: { owner, name, full_name: DEFAULT_REPO },
    notifications,
    pagination: {
      before_cursor: null,
      after_cursor: null,
      has_previous: false,
      has_next: false,
    },
    ...overrides,
  };
}

export function makeCommentThread(overrides: Record<string, unknown> = {}) {
  const thread: Record<string, unknown> = {
    notificationUpdatedAt: '2025-01-02T00:00:00Z',
    lastReadAt: '2025-01-01T00:00:00Z',
    unread: true,
    allComments: false,
    fetchedAt: new Date().toISOString(),
    comments: [],
    reviews: [],
    ...overrides,
  };
  if (thread.reviewDecision && !thread.reviewDecisionFetchedAt) {
    thread.reviewDecisionFetchedAt = new Date().toISOString();
  }
  return thread;
}

export function makeCommentCache(threads: Record<string, unknown>) {
  return { version: 1, threads };
}

function fulfillJson(route: Route, body: JsonBody, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function notificationsArray(payload: JsonBody) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object' && 'notifications' in payload) {
    const notifications = (payload as { notifications?: unknown }).notifications;
    if (Array.isArray(notifications)) {
      return notifications;
    }
  }
  return [];
}

export const testIds = {
  notification: (id: string) => `[data-id="${id}"]`,
  notificationCheckbox: (id: string) => `[data-id="${id}"] .notification-checkbox`,
};

export function viewTab(page: Page, view: 'issues' | 'pr-notifications' | 'others-prs' | 'cleaned') {
  return page.locator(`#view-${view}`);
}

export function subfilterTab(
  page: Page,
  view: 'issues' | 'pr-notifications' | 'others-prs' | 'cleaned',
  subfilter: string,
  group?: 'state' | 'author' | 'interest' | 'bookmark' | 'type' | 'audience'
) {
  const groupSelector = group ? `[data-subfilter-group="${group}"]` : '';
  return page
    .locator(`.subfilter-tabs[data-for-view="${view}"]${groupSelector}`)
    .locator(`[data-subfilter="${subfilter}"]`);
}

export async function mockDefaultApiRoutes(page: Page, options: {
  login?: string;
  notifications?: JsonBody;
  repo?: string;
} = {}) {
  const login = options.login ?? DEFAULT_LOGIN;
  const notifications = options.notifications ?? mixedFixture;
  const repo = options.repo ?? DEFAULT_REPO;
  const [owner, name] = repo.split('/');

  await page.route('**/github/rest/user', (route) => fulfillJson(route, { login }));
  await page.route('**/github/rest/rate_limit', (route) =>
    fulfillJson(route, {
      resources: {
        core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 },
        graphql: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 },
      },
    })
  );
  await page.route('**/notifications/html/repo/**', (route) => fulfillJson(route, notifications));
  await page.route('**/github/rest/review-requests**', (route) =>
    fulfillJson(route, { notifications: [] })
  );
  await page.route('**/github/graphql', (route) => fulfillJson(route, { data: { repository: {} } }));
  await page.route('**/github/rest/repos/**/issues/**/comments**', (route) => fulfillJson(route, []));
  await page.route('**/github/rest/repos/**/issues/**', (route) => {
    if (route.request().url().includes('/comments')) {
      return route.fallback();
    }
    return fulfillJson(route, { id: 1, body: '', user: { login } });
  });
  await page.route(`**/api/snapshots/${owner}/${name}`, (route) => fulfillJson(route, { snapshot: null }));
  await mockServerSnapshotSyncUnavailable(page, repo);
}

export async function mockServerSnapshotSyncUnavailable(
  page: Page,
  repo: string = DEFAULT_REPO
) {
  const [owner, name] = repo.split('/');
  await page.route(`**/api/snapshots/${owner}/${name}/sync`, (route) =>
    fulfillJson(
      route,
      { detail: 'No GitHub fetcher configured. Start server with --account.' },
      503
    )
  );
}

export async function mockHtmlAction(
  page: Page,
  body: JsonBody = { status: 'ok' },
  options: { status?: number } = {}
) {
  await page.route('**/notifications/html/action', (route) =>
    fulfillJson(route, body, options.status ?? 200)
  );
}

export type CapturedHtmlAction = { action?: string; notification_ids?: string[] };

export async function captureHtmlActions(page: Page) {
  const actions: CapturedHtmlAction[] = [];
  await page.route('**/notifications/html/action', (route) => {
    actions.push(route.request().postDataJSON());
    return fulfillJson(route, { status: 'ok' });
  });
  return actions;
}

// Routes registered after mockDefaultApiRoutes win (Playwright matches routes
// newest-first), so specs override only the endpoints whose payload differs.
export async function mockNotificationsResponse(page: Page, notifications: JsonBody) {
  await page.route('**/notifications/html/repo/**', (route) =>
    fulfillJson(route, notifications)
  );
}

export async function mockReviewRequests(page: Page, notifications: unknown[]) {
  await page.route('**/github/rest/review-requests**', (route) =>
    fulfillJson(route, { notifications })
  );
}

// Mocks the GraphQL review-metadata batch query. `prFields` is keyed by the
// alias the client generates per PR number (pr10, pr11, ...).
export async function mockGraphqlReviewMetadata(
  page: Page,
  prFields: Record<string, Record<string, unknown>>
) {
  await page.route('**/github/graphql', (route) => {
    const payload = route.request().postDataJSON();
    const rateLimit = { limit: 5000, remaining: 4999, resetAt: '2025-01-05T00:00:00Z' };
    if (payload?.query?.includes('pullRequest') || payload?.query?.includes('repository')) {
      return fulfillJson(route, { data: { rateLimit, repository: prFields } });
    }
    return fulfillJson(route, { data: { rateLimit } });
  });
}

// Sync via the UI and wait until the cached notification count settles.
// Use when synced items render across several views, so a single
// .notification-item count can't confirm completion.
export async function syncNotificationsUntilCached(page: Page, options: {
  expectedCount: number;
  repo?: string;
}) {
  await page.locator('#repo-input').fill(options.repo ?? DEFAULT_REPO);
  await page.locator('#sync-btn').click();
  await expect
    .poll(async () => {
      const cached = await readNotificationsCache(page);
      return Array.isArray(cached) ? cached.length : 0;
    })
    .toBe(options.expectedCount);
}

// Open the app with default mocks, clear storage, optionally seed the comment
// cache, then sync. The standard setup for classification/triage specs.
export async function openNotificationsWithCommentCache(page: Page, options: {
  commentCache?: JsonBody;
  expectedCount: number;
  graphqlPrFields?: Record<string, Record<string, unknown>>;
  login?: string;
  notifications?: JsonBody;
  repo?: string;
}) {
  await mockDefaultApiRoutes(page, options);
  if (options.graphqlPrFields) {
    await mockGraphqlReviewMetadata(page, options.graphqlPrFields);
  }
  await page.goto('notifications.html', { waitUntil: 'domcontentloaded' });
  await clearAppStorage(page);
  if (options.commentCache !== undefined) {
    await seedCommentCache(page, options.commentCache);
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await syncNotificationsUntilCached(page, {
    expectedCount: options.expectedCount,
    repo: options.repo,
  });
}

export async function replaceHtmlAction(page: Page, handler: RouteHandler) {
  await page.unroute('**/notifications/html/action').catch(() => undefined);
  await page.route('**/notifications/html/action', handler);
}

export async function openNotificationsApp(page: Page, options: {
  login?: string;
  repo?: string;
} = {}) {
  const login = options.login ?? DEFAULT_LOGIN;
  const repo = options.repo ?? DEFAULT_REPO;

  await addAuthCacheInitScript(page, login);
  await page.addInitScript(
    ({ repoKey, repoValue }) => {
      localStorage.setItem(repoKey, repoValue);
    },
    { repoKey: APP_STORAGE_KEYS.repo, repoValue: repo }
  );
  await page.goto('notifications.html', { waitUntil: 'domcontentloaded' });
}

export async function syncNotifications(page: Page, options: {
  expectedCount?: number;
  repo?: string;
} = {}) {
  const expectedCount = options.expectedCount ?? 4;
  const repo = options.repo ?? DEFAULT_REPO;

  await page.locator('#repo-input').fill(repo);
  await page.locator('#sync-btn').click();
  await expect(page.locator('.notification-item')).toHaveCount(expectedCount);
}

export async function openNotificationsWithSync(page: Page, options: {
  expectedCount?: number;
  login?: string;
  notifications?: JsonBody;
  repo?: string;
} = {}) {
  const expectedCount = options.expectedCount ?? 4;
  const repo = options.repo ?? DEFAULT_REPO;

  await mockDefaultApiRoutes(page, options);
  await openNotificationsApp(page, options);
  await clearAppStorage(page);
  await syncNotifications(page, { expectedCount, repo });
}

export async function openNotificationsWithCachedData(page: Page, options: {
  commentCache?: JsonBody;
  expectedCount?: number;
  login?: string;
  notifications?: JsonBody;
  repo?: string;
} = {}) {
  const expectedCount = options.expectedCount ?? 4;
  const repo = options.repo ?? DEFAULT_REPO;

  await mockDefaultApiRoutes(page, options);
  await page.goto('notifications.html', { waitUntil: 'domcontentloaded' });
  await clearAppStorage(page);
  await seedAuthCache(page, options.login ?? DEFAULT_LOGIN);
  await seedRepoSelection(page, repo, { lastSynced: true });
  if (options.commentCache !== undefined) {
    await seedCommentCache(page, options.commentCache);
  }
  await seedNotificationsCache(page, notificationsArray(options.notifications ?? mixedFixture));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.notification-item')).toHaveCount(expectedCount);
}

export async function expectVisibleNotificationIds(page: Page, ids: string[]) {
  await expect(page.locator('.notification-item')).toHaveCount(ids.length);
  for (const id of ids) {
    await expect(page.locator(testIds.notification(id))).toBeVisible();
  }
}

export async function expectHiddenNotificationIds(page: Page, ids: string[]) {
  for (const id of ids) {
    await expect(page.locator(testIds.notification(id))).not.toBeAttached();
  }
}

export async function selectNotification(page: Page, id: string, options: { shift?: boolean } = {}) {
  await page.locator(testIds.notificationCheckbox(id)).click({
    modifiers: options.shift ? ['Shift'] : undefined,
  });
}

export async function expectSelectionCount(page: Page, text: string) {
  await expect(page.locator('#selection-count')).toHaveText(text);
}
