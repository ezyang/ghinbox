const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILES,
  buildProfiles,
  classifyProfileEntry,
  getNotificationsCacheKey,
  getProfileEntriesStorageValue,
  getProfileEntriesText,
  getProfileSignature,
  normalizeProfile,
  resolveInitialProfileId,
  splitProfileEntries,
} = require('../../ghinbox/webapp/notifications-profiles.js');

test('splitProfileEntries splits on newlines and commas and trims', () => {
  const cases = [
    { input: null, expected: [] },
    { input: '', expected: [] },
    { input: 'pytorch/pytorch', expected: ['pytorch/pytorch'] },
    { input: 'a/b\nc/d', expected: ['a/b', 'c/d'] },
    { input: ' a/b , c/d ', expected: ['a/b', 'c/d'] },
    { input: 'a/b,\n\n,c/d', expected: ['a/b', 'c/d'] },
  ];
  for (const { input, expected } of cases) {
    assert.deepEqual(splitProfileEntries(input), expected, `input=${JSON.stringify(input)}`);
  }
});

test('classifyProfileEntry classifies repos, repo: queries, queries, and invalid words', () => {
  const cases = [
    {
      input: 'pytorch/pytorch',
      expected: {
        kind: 'repo',
        value: 'pytorch/pytorch',
        owner: 'pytorch',
        repo: 'pytorch',
        fullName: 'pytorch/pytorch',
        query: 'repo:pytorch/pytorch',
      },
    },
    {
      input: '  a/b  ',
      expected: {
        kind: 'repo',
        value: 'a/b',
        owner: 'a',
        repo: 'b',
        fullName: 'a/b',
        query: 'repo:a/b',
      },
    },
    {
      // Pins CURRENT behavior: parseRepoInput splits on '/' before the
      // repo:owner/name branch can run, so the owner keeps the 'repo:'
      // prefix and the query doubles it. Almost certainly not intended;
      // change this table deliberately if the misparse is ever fixed.
      input: 'repo:pytorch/vision',
      expected: {
        kind: 'repo',
        value: 'repo:pytorch/vision',
        owner: 'repo:pytorch',
        repo: 'vision',
        fullName: 'repo:pytorch/vision',
        query: 'repo:repo:pytorch/vision',
      },
    },
    {
      input: 'org:pytorch',
      expected: { kind: 'query', value: 'org:pytorch', query: 'org:pytorch' },
    },
    {
      input: '-org:pytorch -org:meta-pytorch',
      expected: {
        kind: 'query',
        value: '-org:pytorch -org:meta-pytorch',
        query: '-org:pytorch -org:meta-pytorch',
      },
    },
    {
      input: 'pytorch',
      expected: { kind: 'invalid', value: 'pytorch', query: 'pytorch' },
    },
    {
      input: 'a/b/c',
      expected: { kind: 'invalid', value: 'a/b/c', query: 'a/b/c' },
    },
  ];
  for (const { input, expected } of cases) {
    assert.deepEqual(classifyProfileEntry(input), expected, `input=${JSON.stringify(input)}`);
  }
});

test('normalizeProfile fills from the fallback and rejects missing ids', () => {
  const fallback = { id: 'custom', name: 'Custom', entries: ['a/b'], system: false };
  assert.deepEqual(normalizeProfile({ id: 'custom', entries: [' c/d ', ''] }, fallback), {
    id: 'custom',
    name: 'Custom',
    entries: ['c/d'],
    system: false,
  });
  assert.deepEqual(normalizeProfile({ id: 'custom' }, fallback), {
    id: 'custom',
    name: 'Custom',
    entries: ['a/b'],
    system: false,
  });
  assert.equal(normalizeProfile({ name: 'No id' }, null), null);
});

test('buildProfiles returns the defaults when nothing is saved', () => {
  const profiles = buildProfiles(null, null);
  assert.deepEqual(profiles.map((p) => p.id), ['pytorch', 'everything-else', 'custom']);
  assert.deepEqual(profiles, DEFAULT_PROFILES);
  // Mutating the result must not corrupt the defaults for later calls.
  profiles[2].entries.push('x/y');
  assert.deepEqual(buildProfiles(null, null)[2].entries, ['pytorch/pytorch']);
});

test('buildProfiles applies a saved custom profile but never system profiles', () => {
  const saved = [
    { id: 'custom', name: 'Custom', entries: ['a/b', 'c/d'], system: false },
    { id: 'pytorch', name: 'Hijacked', entries: ['evil/query'], system: true },
    { id: 'unknown', name: 'Dropped', entries: ['x/y'] },
  ];
  const profiles = buildProfiles(saved, null);
  assert.deepEqual(profiles.map((p) => p.id), ['pytorch', 'everything-else', 'custom']);
  assert.equal(profiles[0].name, 'All notifications');
  assert.deepEqual(profiles[2].entries, ['a/b', 'c/d']);
});

test('buildProfiles migrates a legacy repo only into an untouched custom profile', () => {
  const migrated = buildProfiles(null, 'a/b\nc/d');
  assert.deepEqual(migrated[2].entries, ['a/b', 'c/d']);

  const saved = [{ id: 'custom', name: 'Custom', entries: ['e/f'], system: false }];
  const untouched = buildProfiles(saved, 'a/b');
  assert.deepEqual(untouched[2].entries, ['e/f']);
});

test('resolveInitialProfileId prefers saved id, then legacy custom, then the default', () => {
  const profiles = buildProfiles(null, null);
  const cases = [
    { saved: 'everything-else', legacy: null, expected: 'everything-else' },
    { saved: 'missing', legacy: 'a/b', expected: 'custom' },
    { saved: null, legacy: '  ', expected: DEFAULT_PROFILE_ID },
    { saved: null, legacy: null, expected: DEFAULT_PROFILE_ID },
  ];
  for (const { saved, legacy, expected } of cases) {
    assert.equal(
      resolveInitialProfileId(profiles, saved, legacy),
      expected,
      `saved=${saved} legacy=${legacy}`
    );
  }
});

test('signature, cache key, entries text, and storage value derivations', () => {
  const profile = { id: 'custom', entries: ['a/b', 'org:x'] };
  assert.equal(getProfileEntriesText(profile), 'a/b\norg:x');
  assert.equal(getProfileSignature(profile), 'custom:a/b\norg:x');
  assert.equal(getNotificationsCacheKey(profile), 'profile:custom:a/b\norg:x');
  assert.equal(getProfileSignature(null), 'unknown:');
  assert.equal(getProfileEntriesStorageValue(['a/b']), 'a/b');
  assert.equal(getProfileEntriesStorageValue(['a/b', 'c/d']), 'a/b\nc/d');
  assert.equal(getProfileEntriesStorageValue([]), '');
});
