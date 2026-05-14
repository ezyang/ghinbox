# E2E Test Guide

Use Playwright for browser behavior: rendering, storage integration, keyboard and
mouse workflows, network wiring, and layout. Keep pure classification, filtering,
sorting, sync decisions, and comment-interest rules in compact unit/table tests
when those seams are available.

## Commands

- `npm test`: default fast suite, excluding `@slow`.
- `npm run test:agent`: smallest PR-agent suite, currently `@smoke`.
- `npm run test:full`: exhaustive suite.
- `npm run test:sync`, `npm run test:actions`, `npm run test:classification`,
  `npm run test:layout`, and `npm run test:mutation`: focused lanes.

Unset proxy variables before running tests:

```sh
unset HTTPS_PROXY HTTP_PROXY X2P_AGENT_PROXY_ADDRESS && npm test
```

## Authoring Pattern

Prefer `app-fixture.ts` helpers before adding route/setup boilerplate to a spec:

```ts
import { test, expect } from '@playwright/test';
import {
  expectVisibleNotificationIds,
  openNotificationsWithCachedData,
  selectNotification,
  subfilterTab,
} from './app-fixture';

test('regression: closed feed selection stays selected @smoke', async ({ page }) => {
  await openNotificationsWithCachedData(page);

  await subfilterTab(page, 'issues', 'closed', 'state').click();
  await selectNotification(page, 'notif-3');

  await expectVisibleNotificationIds(page, ['notif-3']);
  await expect(page.locator('#selection-count')).toHaveText('1 selected');
});
```

Every regression test should have one clear action and at least one explicit
`expect()` assertion. Add `@slow` only when the scenario is intentionally
exhaustive or waits on long async behavior.
