const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isNotificationDirectedAtCurrentUser,
  shouldShowMoveToFeed,
} = require('../../ghinbox/webapp/notifications-comment-interest.js');

const CURRENT_USER = 'testuser';
const HUMAN = 'alice';

const subjects = [
  {
    key: 'authored-pr',
    label: 'authored PR',
    type: 'PullRequest',
    reason: 'author',
    authorLogin: CURRENT_USER,
    replyStyle: 'main-thread',
  },
  {
    key: 'authored-issue',
    label: 'authored issue',
    type: 'Issue',
    reason: 'author',
    authorLogin: CURRENT_USER,
    replyStyle: 'main-thread',
  },
  {
    key: 'participating-thread',
    label: 'participating thread',
    type: 'Issue',
    reason: 'comment',
    authorLogin: 'owner',
    replyStyle: 'main-thread',
  },
  {
    key: 'review-requested',
    label: 'review-requested PR',
    type: 'PullRequest',
    reason: 'review_requested',
    authorLogin: 'owner',
    replyStyle: 'review-thread',
  },
];

const states = [
  {
    key: 'open',
    label: 'open',
    subjectState: 'open',
    closeMinute: null,
  },
  {
    key: 'closed-pre-close',
    label: 'closed with replies only before close',
    subjectState: 'closed',
    closeMinute: 50,
  },
  {
    key: 'closed-post-close',
    label: 'closed with a reply after close',
    subjectState: 'closed',
    closeMinute: 15,
  },
];

const lastActors = [
  {
    key: 'human',
    label: 'real human',
    notificationActor: HUMAN,
    commentActorKind: 'human',
  },
  {
    key: 'known-bot',
    label: 'known bot',
    notificationActor: 'github-actions[bot]',
    commentActorKind: 'known-bot',
  },
  {
    key: 'claude-delegated',
    label: 'claude[bot] delegated-task completion',
    notificationActor: 'claude[bot]',
    commentActorKind: 'claude-delegated',
  },
  {
    key: 'current-user',
    label: 'the user themself',
    notificationActor: CURRENT_USER,
    commentActorKind: 'current-user',
  },
];

const watermarks = [
  {
    key: 'own-before-other-party',
    label: "user's own comment before newest other-party comments",
    ownAfterOtherParty: false,
  },
  {
    key: 'own-after-other-party',
    label: "user's own comment after newest other-party comments",
    ownAfterOtherParty: true,
  },
];

function atMinute(minute) {
  return new Date(Date.UTC(2025, 0, 1, 0, minute, 0)).toISOString();
}

function comment(id, minute, login, body, extra = {}) {
  return {
    id,
    body,
    user: { login },
    created_at: atMinute(minute),
    updated_at: atMinute(minute),
    ...extra,
  };
}

function commentAuthorFor(actorKind) {
  if (actorKind === 'known-bot') {
    return 'github-actions[bot]';
  }
  if (actorKind === 'claude-delegated') {
    return 'claude[bot]';
  }
  if (actorKind === 'current-user') {
    return CURRENT_USER;
  }
  return HUMAN;
}

function commentBodyFor(actorKind) {
  if (actorKind === 'known-bot') {
    return `CI passed for @${CURRENT_USER}.`;
  }
  if (actorKind === 'claude-delegated') {
    return `**Claude finished @${CURRENT_USER}'s task** - implementation is complete.`;
  }
  if (actorKind === 'current-user') {
    return 'I handled this myself.';
  }
  return 'I pushed the requested follow-up.';
}

function commentExtraFor(subject, id) {
  if (subject.type !== 'Issue') {
    if (subject.replyStyle === 'review-thread' && id !== 1) {
      return { isReviewComment: true, in_reply_to_id: 1 };
    }
    if (subject.replyStyle === 'review-thread') {
      return { isReviewComment: true };
    }
    return {};
  }
  return { isIssue: true };
}

function notificationFor(subject, state, lastActor) {
  return {
    id: `${subject.key}-${state.key}-${lastActor.key}`,
    reason: subject.reason,
    actors: [{ login: lastActor.notificationActor, avatar_url: '' }],
    subject: {
      type: subject.type,
      state: state.subjectState,
      title: `${subject.label} ${state.label}`,
    },
  };
}

function commentsFor(subject, state, lastActor, watermark) {
  const targetAuthor = commentAuthorFor(lastActor.commentActorKind);
  const targetBody = commentBodyFor(lastActor.commentActorKind);
  const own = comment(
    1,
    10,
    CURRENT_USER,
    lastActor.commentActorKind === 'claude-delegated'
      ? '@claude Please handle the pending task.'
      : 'I am looking at this.',
    commentExtraFor(subject, 1)
  );
  const target = comment(
    2,
    20,
    targetAuthor,
    targetBody,
    commentExtraFor(subject, 2)
  );
  if (
    lastActor.commentActorKind === 'current-user' &&
    watermark.ownAfterOtherParty
  ) {
    const otherParty = comment(
      2,
      20,
      HUMAN,
      commentBodyFor('human'),
      commentExtraFor(subject, 2)
    );
    const ownAfter = comment(
      3,
      30,
      CURRENT_USER,
      targetBody,
      commentExtraFor(subject, 3)
    );
    return [own, otherParty, ownAfter];
  }
  if (!watermark.ownAfterOtherParty) {
    return [own, target];
  }
  const ownAfter = comment(
    3,
    30,
    CURRENT_USER,
    'I saw this and followed up.',
    commentExtraFor(subject, 3)
  );
  return [own, target, ownAfter];
}

function stateEventsFor(state) {
  if (state.closeMinute === null) {
    return [];
  }
  return [{ event: 'closed', created_at: atMinute(state.closeMinute) }];
}

function expectedFor(subject, state, lastActor, watermark) {
  if (state.key === 'closed-pre-close') {
    return {
      route: 'Feed',
      moveToFeed: false,
      reason: 'Closed items ignore comments that happened before the close event.',
    };
  }
  if (watermark.ownAfterOtherParty) {
    return {
      route: 'Feed',
      moveToFeed: false,
      reason: "The user's later own comment is the read watermark for that thread.",
    };
  }
  if (lastActor.commentActorKind === 'known-bot') {
    return {
      route: 'Feed',
      moveToFeed: false,
      reason: 'Known bot comments are uninteresting even when they mention the user.',
    };
  }
  if (lastActor.commentActorKind === 'current-user') {
    return {
      route: 'Feed',
      moveToFeed: false,
      reason: "The user's own latest activity does not create an unread reply.",
    };
  }
  if (lastActor.commentActorKind === 'claude-delegated') {
    return {
      route: 'Replies',
      moveToFeed: false,
      reason: 'Delegated claude[bot] completions that mention the user stay in Replies.',
    };
  }
  if (subject.key === 'review-requested') {
    return {
      route: 'Replies',
      moveToFeed: false,
      reason: 'Review-thread replies after the user are direct replies, not mutable participation.',
    };
  }
  return {
    route: 'Replies',
    moveToFeed: true,
    reason: 'Unread human participation or authored-subject replies route to Replies.',
  };
}

const rows = subjects.flatMap((subject) =>
  states.flatMap((state) =>
    lastActors.flatMap((lastActor) =>
      watermarks.map((watermark) => ({
        subject,
        state,
        lastActor,
        watermark,
        ...expectedFor(subject, state, lastActor, watermark),
      }))
    )
  )
);

function rowKey(row) {
  return [
    row.subject.key,
    row.state.key,
    row.lastActor.key,
    row.watermark.key,
  ].join(' / ');
}

function routeFor(notification, options) {
  return isNotificationDirectedAtCurrentUser(notification, options)
    ? 'Replies'
    : 'Feed';
}

test('routing decision table covers every requested dimension', () => {
  const expectedCount =
    subjects.length * states.length * lastActors.length * watermarks.length;
  assert.equal(rows.length, expectedCount);
  assert.equal(new Set(rows.map(rowKey)).size, expectedCount);
  rows.forEach((row) => {
    assert.ok(row.reason, `missing reason for ${rowKey(row)}`);
  });
});

rows.forEach((row) => {
  test(`routing decision table: ${rowKey(row)}`, () => {
    const notification = notificationFor(row.subject, row.state, row.lastActor);
    const options = {
      authorLogin: row.subject.authorLogin,
      comments: commentsFor(row.subject, row.state, row.lastActor, row.watermark),
      currentUserLogin: CURRENT_USER,
      lastReadAt: null,
      stateEvents: stateEventsFor(row.state),
    };
    const actualRoute = routeFor(notification, options);
    assert.equal(actualRoute, row.route, row.reason);
    assert.equal(
      shouldShowMoveToFeed(notification, {
        ...options,
        view: 'pr-notifications',
      }),
      row.moveToFeed,
      `${row.reason} (without precomputed directed state)`
    );
    assert.equal(
      shouldShowMoveToFeed(notification, {
        ...options,
        directedAtCurrentUser: actualRoute === 'Replies',
        view: 'pr-notifications',
      }),
      row.moveToFeed,
      `${row.reason} (with precomputed directed state)`
    );
  });
});

test('move-to-feed helper gates on view and existing mute state', () => {
  const subject = subjects[0];
  const state = states[0];
  const lastActor = lastActors[0];
  const watermark = watermarks[0];
  const notification = notificationFor(subject, state, lastActor);
  const options = {
    authorLogin: subject.authorLogin,
    comments: commentsFor(subject, state, lastActor, watermark),
    currentUserLogin: CURRENT_USER,
    lastReadAt: null,
    stateEvents: stateEventsFor(state),
  };

  assert.equal(
    shouldShowMoveToFeed(notification, { ...options, view: 'issues' }),
    false
  );
  assert.equal(
    shouldShowMoveToFeed(
      { ...notification, ui: { replies_muted: true } },
      { ...options, view: 'pr-notifications' }
    ),
    false
  );
});
