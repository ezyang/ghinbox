# E2E Fixture Porting Checklist

This document describes how to port E2E tests to use real GitHub fixtures instead of hand-written synthetic data.

## Current State

### Fixture Types

| Fixture | Source | Format | Used By |
|---------|--------|--------|---------|
| `notifications_empty.json` | Hand-written | JSON | sync.spec.ts |
| `notifications_mixed.json` | Hand-written | JSON | sync, filtering, selection, mark-done, polish |
| `notifications_pagination_page1.json` | Generated from HTML | JSON | (new) |
| `notifications_pagination_page2.json` | Generated from HTML | JSON | (new) |
| `notifications_before_done.json` | Generated from HTML | JSON | (new) |
| `notifications_after_done.json` | Generated from HTML | JSON | (new) |
| `notifications_inbox.json` | Generated from HTML | JSON | (new) |

### Key Differences: Synthetic vs Real Fixtures

| Aspect | Synthetic (`notifications_mixed.json`) | Real (generated from flows) |
|--------|---------------------------------------|----------------------------|
| IDs | Simple: `notif-1`, `notif-2`, etc. | GitHub node IDs: `NT_kwDOAZShobQy...` |
| Count | Fixed: exactly 5 | Variable: depends on flow |
| States | Predictable distribution | Real distribution from test |
| Usernames | Fake: `alice`, `bob`, etc. | Real: `ezyang0`, `htmlpurifierbot` |
| Timestamps | Static | Real timestamps from capture |

## Porting Strategy

### Recommended Approach: Hybrid Fixtures

1. **Keep synthetic fixtures for deterministic tests**
   - Tests that assert on specific IDs (e.g., `[data-id="notif-1"]`)
   - Tests that assert on exact counts (e.g., "Synced 5 notifications")
   - Tests for specific state distributions (e.g., "2 open, 3 closed")

2. **Use real fixtures for realistic scenario tests**
   - Pagination tests (25+ notifications)
   - Parser validation tests
   - UI rendering with real data structures

3. **Create "normalized" fixtures for integration tests**
   - Parse real HTML but post-process to stabilize IDs if needed

## Test File Analysis

### `sync.spec.ts`
**Current fixtures:** `emptyResponse`, `mixedResponse`
**Porting difficulty:** Medium

| Test | Fixture Dependency | Porting Action |
|------|-------------------|----------------|
| sync button triggers API call | `emptyResponse` | Keep synthetic |
| sync fetches notifications and displays count | `mixedResponse` (expects 5) | Keep synthetic OR update assertion |
| sync stores notifications in localStorage | `mixedResponse` (expects 5) | Keep synthetic OR update assertion |
| notifications persist across page reload | `mixedResponse` (expects 5) | Keep synthetic OR update assertion |
| sync traverses multiple pages | Custom inline | Replace with `notifications_pagination_page1/2.json` |
| notifications are sorted by updated_at | Custom inline | Keep inline |

**Recommendation:**
- Keep `emptyResponse` and `mixedResponse` for basic tests
- Use real pagination fixtures for pagination tests

### `filtering.spec.ts`
**Current fixtures:** `mixedFixture`
**Porting difficulty:** High

| Test | Fixture Dependency | Porting Action |
|------|-------------------|----------------|
| updates counts after sync | Expects "5 total, 2 open, 3 closed" | Keep synthetic |
| clicking Open tab filters | Expects specific IDs visible | Keep synthetic |
| clicking Closed tab filters | Expects specific IDs visible | Keep synthetic |
| filter tab counts | Expects specific distribution | Keep synthetic |

**Recommendation:** Keep synthetic fixtures. These tests validate filter logic against known data.

### `selection.spec.ts`
**Current fixtures:** `mixedFixture`
**Porting difficulty:** Medium

| Test | Fixture Dependency | Porting Action |
|------|-------------------|----------------|
| each notification has a checkbox | Expects 5 checkboxes | Keep synthetic OR use `.first()` |
| checkboxes are unchecked by default | Expects 5 | Keep synthetic |
| clicking checkbox selects notification | Any fixture works | Can use real |
| shift-click range selection | Needs predictable order | Keep synthetic |

**Recommendation:** Keep synthetic for count-dependent tests. Selection mechanics work with any fixture.

### `mark-done.spec.ts`
**Current fixtures:** `mixedFixture` + custom `fixtureWithNodeIds`
**Porting difficulty:** Low

| Test | Fixture Dependency | Porting Action |
|------|-------------------|----------------|
| Mark Done button visibility | Any fixture | Can use real |
| Mark Done sends PATCH requests | Uses `fixtureWithNodeIds` | Replace with real fixture |
| Progress indicator | Any fixture | Can use real |
| Error handling | Any fixture | Can use real |

**Recommendation:** Can largely use real fixtures. The `fixtureWithNodeIds` pattern shows tests already expect real-looking IDs.

### `rendering.spec.ts`
**Current fixtures:** Inline `testNotifications`
**Porting difficulty:** Low

| Test | Fixture Dependency | Porting Action |
|------|-------------------|----------------|
| Icon tests | Needs various states | Use `notifications_pagination_page1.json` |
| State badge tests | Needs various states | Use real fixture with variety |
| Timestamp tests | Any fixture | Can use real |
| Actor avatar tests | Needs actors | Use real (has real avatars) |

**Recommendation:** Replace inline fixture with real fixture for more realistic rendering tests.

### `smoke.spec.ts`
**Current fixtures:** Minimal inline mocks
**Porting difficulty:** None needed

**Recommendation:** Keep as-is. Smoke tests should use minimal setup.

### `polish.spec.ts`
**Current fixtures:** `mixedFixture`
**Porting difficulty:** Low

**Recommendation:** Can use real fixtures if tests don't depend on specific IDs/counts.

### `ui-shell.spec.ts`
**Current fixtures:** None/minimal
**Porting difficulty:** None needed

**Recommendation:** Keep as-is.

## Step-by-Step Porting Procedure

### For tests that can use real fixtures:

1. **Import the real fixture:**
   ```typescript
   import paginationPage1 from '../fixtures/notifications_pagination_page1.json';
   ```

2. **Update route mock:**
   ```typescript
   await page.route('**/notifications/html/repo/**', (route) => {
     route.fulfill({
       status: 200,
       contentType: 'application/json',
       body: JSON.stringify(paginationPage1),
     });
   });
   ```

3. **Update assertions to be dynamic:**
   ```typescript
   // Instead of: await expect(items).toHaveCount(5);
   const count = paginationPage1.notifications.length;
   await expect(items).toHaveCount(count);
   ```

4. **Update ID-based selectors:**
   ```typescript
   // Instead of: page.locator('[data-id="notif-1"]')
   const firstId = paginationPage1.notifications[0].id;
   page.locator(`[data-id="${firstId}"]`);
   ```

### For tests that need predictable data:

Keep using `notifications_mixed.json` but document the expected structure:
```typescript
/**
 * notifications_mixed.json structure:
 * - 5 notifications total
 * - IDs: notif-1 through notif-5
 * - States: 2 open (notif-1, notif-2), 3 closed (notif-3, notif-4, notif-5)
 * - notif-4 is merged PR, notif-5 is not_planned issue
 */
import mixedFixture from '../fixtures/notifications_mixed.json';
```

## Fixture Refresh Workflow

When GitHub's HTML structure changes:

```bash
# 1. Run a flow to capture fresh HTML
python -m ghsim.run_flow pagination owner_account trigger_account

# 2. Update HTML fixtures from responses
python -m ghsim.fixtures update --force

# 3. Regenerate E2E JSON fixtures from HTML
python -m ghsim.fixtures generate-e2e --force

# 4. Run E2E tests to verify
npm run test:e2e

# 5. Fix any broken assertions due to data changes
```

## New Test Opportunities

With real fixtures, consider adding tests for:

1. **Pagination with 25+ items** - Use `notifications_pagination_page1.json`
2. **Real avatar rendering** - Real fixtures have actual GitHub avatar URLs
3. **Real notification IDs** - Test that node IDs work correctly
4. **Edge cases from real data** - Long titles, special characters, etc.

## Checklist Summary

- [ ] Keep `notifications_empty.json` as synthetic (trivial fixture)
- [ ] Keep `notifications_mixed.json` as synthetic (deterministic tests need it)
- [ ] Port `sync.spec.ts` pagination tests to use real pagination fixtures
- [ ] Port `rendering.spec.ts` to use real fixtures for realistic rendering
- [ ] Port `mark-done.spec.ts` to use real fixtures (already expects node IDs)
- [ ] Add new test file `pagination.spec.ts` using real pagination fixtures
- [ ] Update `filtering.spec.ts` to document synthetic fixture dependency
- [ ] Update `selection.spec.ts` to document synthetic fixture dependency
- [ ] Verify all tests pass after porting
- [ ] Document fixture refresh workflow in README
