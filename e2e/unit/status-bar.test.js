const assert = require('node:assert/strict');
const test = require('node:test');
const StatusBar = require('../../ghinbox/webapp/notifications-status-bar.js');

function state(overrides = {}) {
  return {
    statusState: null,
    lastPersistentStatus: null,
    statusFlashId: 0,
    statusAutoDismissId: 0,
    ...overrides,
  };
}

function show(current, message, type, options) {
  return StatusBar.showStatus(current, { message, type, options });
}

function effectTypes(result) {
  return result.effects.map((effect) => effect.type);
}

test('persistent status replaces current text and becomes the restore target', () => {
  const transition = show(state(), 'Sync failed', 'error');

  assert.deepEqual(transition.state, {
    statusState: {
      message: 'Sync failed',
      type: 'error',
      isFlash: false,
      flashId: null,
      autoDismiss: false,
    },
    lastPersistentStatus: { message: 'Sync failed', type: 'error' },
    statusFlashId: 0,
    statusAutoDismissId: 0,
  });
  assert.deepEqual(effectTypes(transition), [
    'cancelAutoDismissTimer',
    'clearAutoDismissVisual',
    'cancelFlashTimer',
    'setStatus',
  ]);
});

test('auto-dismiss status clears persistent restore state and schedules dismiss', () => {
  const transition = show(
    state({ lastPersistentStatus: { message: 'Old', type: 'info' } }),
    'Synced 3 notifications',
    'success',
    { autoDismiss: true }
  );

  assert.equal(transition.state.statusState.autoDismiss, true);
  assert.equal(transition.state.statusAutoDismissId, 1);
  assert.equal(transition.state.lastPersistentStatus, null);
  assert.deepEqual(transition.effects.slice(-2), [
    { type: 'setAutoDismissVisual', durationMs: StatusBar.DEFAULT_AUTO_DISMISS_MS },
    {
      type: 'scheduleAutoDismiss',
      autoDismissId: 1,
      durationMs: StatusBar.DEFAULT_AUTO_DISMISS_MS,
    },
  ]);
});

test('auto-dismiss duration prefers autoDismissMs over durationMs', () => {
  const transition = show(state(), 'Saved', 'success', {
    autoDismiss: true,
    autoDismissMs: 2400,
    durationMs: 1200,
  });

  assert.deepEqual(transition.effects.slice(-2), [
    { type: 'setAutoDismissVisual', durationMs: 2400 },
    { type: 'scheduleAutoDismiss', autoDismissId: 1, durationMs: 2400 },
  ]);
});

test('auto-dismiss duration falls back to durationMs', () => {
  const transition = show(state(), 'Saved', 'success', {
    autoDismiss: true,
    durationMs: 900,
  });

  assert.deepEqual(transition.effects.slice(-2), [
    { type: 'setAutoDismissVisual', durationMs: 900 },
    { type: 'scheduleAutoDismiss', autoDismissId: 1, durationMs: 900 },
  ]);
});

test('flash may replace an info persistent status and then restore it', () => {
  const current = show(state(), 'Quick Sync in progress...', 'info').state;
  const transition = show(current, 'Quick Sync: requesting page 2', 'info', { flash: true });

  assert.equal(transition.state.statusFlashId, 1);
  assert.deepEqual(transition.state.lastPersistentStatus, {
    message: 'Quick Sync in progress...',
    type: 'info',
  });
  assert.deepEqual(transition.effects.at(-1), {
    type: 'scheduleFlashClear',
    flashId: 1,
    durationMs: StatusBar.DEFAULT_FLASH_DURATION_MS,
  });

  const restored = StatusBar.flashTimerFired(transition.state, 1);
  assert.deepEqual(restored.state.statusState, {
    message: 'Quick Sync in progress...',
    type: 'info',
    isFlash: false,
    flashId: null,
    autoDismiss: false,
  });
  assert.deepEqual(effectTypes(restored), ['cancelFlashTimer', 'setStatus']);
});

test('flash duration uses durationMs', () => {
  const transition = show(state(), 'Fetching comments', 'info', {
    flash: true,
    durationMs: 2100,
  });

  assert.deepEqual(transition.effects.at(-1), {
    type: 'scheduleFlashClear',
    flashId: 1,
    durationMs: 2100,
  });
});

test('flash does not replace non-info persistent status', () => {
  const current = show(state(), 'Sync failed', 'error').state;
  const transition = show(current, 'Checking comments', 'info', { flash: true });

  assert.deepEqual(transition.state, current);
  assert.deepEqual(transition.effects, []);
});

test('flash may replace an existing flash', () => {
  const first = show(state(), 'Checking page 1', 'info', { flash: true }).state;
  const second = show(first, 'Checking page 2', 'info', { flash: true });

  assert.equal(second.state.statusFlashId, 2);
  assert.deepEqual(second.state.statusState, {
    message: 'Checking page 2',
    type: 'info',
    isFlash: true,
    flashId: 2,
    autoDismiss: false,
  });
});

test('flash with autoDismiss option still follows flash policy', () => {
  const transition = show(state(), 'Checking page 1', 'info', {
    autoDismiss: true,
    flash: true,
  });

  assert.equal(transition.state.statusAutoDismissId, 0);
  assert.equal(transition.state.statusState.autoDismiss, false);
  assert.equal(transition.effects.at(-1).type, 'scheduleFlashClear');
});

test('stale flash timer does not change current status', () => {
  const first = show(state(), 'Checking page 1', 'info', { flash: true }).state;
  const second = show(first, 'Checking page 2', 'info', { flash: true }).state;
  const transition = StatusBar.flashTimerFired(second, 1);

  assert.deepEqual(transition.state, second);
  assert.deepEqual(transition.effects, []);
});

test('flash timer clears status when there is no persistent status to restore', () => {
  const current = show(state(), 'Checking page 1', 'info', { flash: true }).state;
  const transition = StatusBar.flashTimerFired(current, 1);

  assert.equal(transition.state.statusState, null);
  assert.equal(transition.state.lastPersistentStatus, null);
  assert.deepEqual(effectTypes(transition), [
    'cancelFlashTimer',
    'cancelAutoDismissTimer',
    'clearAutoDismissVisual',
    'clearPinnedVisual',
    'clearStatus',
  ]);
});

test('matching auto-dismiss timer clears status', () => {
  const current = show(state(), 'Marked as done', 'success', { autoDismiss: true }).state;
  const transition = StatusBar.autoDismissTimerFired(current, 1);

  assert.equal(transition.state.statusState, null);
  assert.deepEqual(effectTypes(transition), [
    'cancelFlashTimer',
    'cancelAutoDismissTimer',
    'clearAutoDismissVisual',
    'clearPinnedVisual',
    'clearStatus',
  ]);
});

test('stale auto-dismiss timer does not clear newer status', () => {
  const first = show(state(), 'Marked as done', 'success', { autoDismiss: true }).state;
  const second = show(first, 'Synced 2 notifications', 'success', { autoDismiss: true }).state;
  const transition = StatusBar.autoDismissTimerFired(second, 1);

  assert.deepEqual(transition.state, second);
  assert.deepEqual(transition.effects, []);
});

test('freezing auto-dismiss pins current status without changing text', () => {
  const current = show(state(), 'Marked as done', 'success', { autoDismiss: true }).state;
  const transition = StatusBar.freezeAutoDismiss(current);

  assert.equal(transition.state.statusState.autoDismiss, false);
  assert.deepEqual(effectTypes(transition), [
    'cancelAutoDismissTimer',
    'clearAutoDismissVisual',
    'setPinnedVisual',
  ]);
});

test('clear status clears visible and persistent status', () => {
  const current = show(state(), 'Sync failed', 'error').state;
  const transition = StatusBar.clearStatus(current);

  assert.equal(transition.state.statusState, null);
  assert.equal(transition.state.lastPersistentStatus, null);
  assert.deepEqual(effectTypes(transition), [
    'cancelFlashTimer',
    'cancelAutoDismissTimer',
    'clearAutoDismissVisual',
    'clearPinnedVisual',
    'clearStatus',
  ]);
});
