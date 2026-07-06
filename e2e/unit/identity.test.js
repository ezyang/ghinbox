const assert = require('node:assert/strict');
const test = require('node:test');
const Identity = require('../../ghinbox/webapp/notifications-identity.js');

function notification(id, overrides = {}) {
  const { subject: subjectOverrides = {}, ...rest } = overrides;
  return {
    id,
    repository: { full_name: 'owner/repo' },
    subject: {
      type: 'Issue',
      number: 12,
      url: 'https://api.github.com/repos/owner/repo/issues/12',
      ...subjectOverrides,
    },
    ...rest,
  };
}

test('getRepoInfo prefers repository full_name and parses fallback values', () => {
  assert.deepEqual(Identity.getRepoInfo(notification('n1')), {
    owner: 'owner',
    repo: 'repo',
    fullName: 'owner/repo',
  });

  assert.deepEqual(
    Identity.getRepoInfo({ subject: { url: '' } }, { owner: 'fallback', repo: 'project' }),
    {
      owner: 'fallback',
      repo: 'project',
      fullName: 'fallback/project',
    }
  );
});

test('getRepoInfo parses web and API GitHub URLs', () => {
  assert.deepEqual(
    Identity.getRepoInfo({
      subject: { url: 'https://github.com/acme/widgets/pull/44' },
    }),
    {
      owner: 'acme',
      repo: 'widgets',
      fullName: 'acme/widgets',
    }
  );

  assert.deepEqual(
    Identity.getRepoInfo({
      subject: { url: 'https://api.github.com/repos/acme/widgets/issues/45' },
    }),
    {
      owner: 'acme',
      repo: 'widgets',
      fullName: 'acme/widgets',
    }
  );
});

test('match and dedup keys use repo, type, and issue number when available', () => {
  const notif = notification('node-1', {
    subject: {
      type: 'PullRequest',
      number: 99,
      url: 'https://github.com/owner/repo/pull/99',
    },
  });

  assert.equal(Identity.getNotificationKey(notif), 'node-1');
  assert.equal(Identity.getIssueNumber(notif), 99);
  assert.equal(Identity.getNotificationMatchKey(notif), 'owner/repo:PullRequest:99');
  assert.equal(Identity.getNotificationDedupKey(notif), 'owner/repo:PullRequest:99');
  assert.equal(
    Identity.getNotificationMatchKeyForRepo(notif, {
      owner: 'override',
      repo: 'target',
      fullName: 'override/target',
    }),
    'override/target:PullRequest:99'
  );
});

test('match keys fall back to notification id when repo or issue number is missing', () => {
  assert.equal(
    Identity.getNotificationMatchKey({
      id: 'missing-number',
      repository: { full_name: 'owner/repo' },
      subject: { type: 'Issue', url: 'https://github.com/owner/repo/issues/12' },
    }),
    'id:missing-number'
  );
  assert.equal(
    Identity.getNotificationDedupKey({
      id: 'missing-repo',
      subject: { type: 'Issue', number: 12 },
    }),
    'id:missing-repo'
  );
});

test('getRestNotificationMatchKey parses issue and pull URLs from REST notifications', () => {
  assert.equal(
    Identity.getRestNotificationMatchKey(notification('issue-rest')),
    'owner/repo:Issue:12'
  );
  assert.equal(
    Identity.getRestNotificationMatchKey(notification('pull-rest', {
      subject: {
        type: 'PullRequest',
        url: 'https://api.github.com/repos/owner/repo/pulls/34',
      },
    })),
    'owner/repo:PullRequest:34'
  );
  assert.equal(
    Identity.getRestNotificationMatchKey(notification('pull-web', {
      subject: {
        type: 'PullRequest',
        url: 'https://github.com/owner/repo/pull/35',
      },
    })),
    'owner/repo:PullRequest:35'
  );
  assert.equal(
    Identity.getRestNotificationMatchKey({
      id: 'missing-repo',
      subject: { type: 'Issue', url: 'https://github.com/owner/repo/issues/12' },
    }),
    null
  );
});

test('groupNotificationsByRepo groups notifications by parsed repository', () => {
  const groups = Identity.groupNotificationsByRepo([
    notification('a', { repository: { full_name: 'one/repo' } }),
    notification('b', { repository: { full_name: 'two/repo' } }),
    notification('c', { repository: { full_name: 'one/repo' } }),
    { id: 'ignored', subject: { number: 1 } },
  ]);

  assert.deepEqual(
    groups.map((group) => ({
      repo: group.repoInfo.fullName,
      ids: group.notifications.map((item) => item.id),
    })),
    [
      { repo: 'one/repo', ids: ['a', 'c'] },
      { repo: 'two/repo', ids: ['b'] },
    ]
  );
});
