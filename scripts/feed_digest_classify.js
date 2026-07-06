#!/usr/bin/env node
/*
 * Feed digest notification classifier.
 *
 * This script is intentionally thin: queue/comment-interest decisions come from
 * the same UMD modules that the browser and Node unit tests use.
 */

const path = require('node:path');

const webappDir = path.join(__dirname, '..', 'ghinbox', 'webapp');
const commentInterest = require(path.join(webappDir, 'notifications-comment-interest.js'));
const commentStatus = require(path.join(webappDir, 'notifications-comment-status.js'));
const filtering = require(path.join(webappDir, 'notifications-filtering.js'));

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function getNotificationKey(notification) {
  if (notification?.repository?.full_name && notification?.subject?.url) {
    return `${notification.repository.full_name}#${notification.subject.url}`;
  }
  return notification?.id || notification?.subject?.url || '';
}

function getThread(commentThreads, notification) {
  if (!commentThreads || typeof commentThreads !== 'object') {
    return null;
  }
  const key = getNotificationKey(notification);
  return commentThreads[key] ||
    commentThreads[notification?.id] ||
    commentThreads[notification?.subject?.url] ||
    null;
}

function normalizeInput(payload) {
  if (Array.isArray(payload)) {
    return {
      notifications: payload,
      commentThreads: {},
      currentUserLogin: '',
    };
  }

  const snapshot = payload?.snapshot || {};
  const commentCache = payload?.commentCache || payload?.comment_cache ||
    snapshot.commentCache || snapshot.comment_cache || {};
  return {
    notifications: payload?.notifications || snapshot.notifications || [],
    commentThreads: payload?.commentThreads || payload?.comment_threads ||
      commentCache.threads || {},
    currentUserLogin: payload?.currentUserLogin || payload?.current_user ||
      payload?.currentUser || '',
  };
}

function classifyNotifications(payload) {
  const { notifications, commentThreads, currentUserLogin } = normalizeInput(payload);
  const directedCache = new Map();

  function cachedFor(notification) {
    return getThread(commentThreads, notification);
  }

  function isDirectedAtCurrentUser(notification) {
    const id = notification?.id || getNotificationKey(notification);
    if (directedCache.has(id)) {
      return directedCache.get(id);
    }

    const cached = cachedFor(notification);
    const comments = commentInterest.sortComments(cached?.comments || []);
    const directed = commentInterest.isNotificationDirectedAtCurrentUser(notification, {
      authorLogin: cached?.authorLogin,
      comments,
      currentUserLogin,
      lastReadAt: cached?.lastReadAt,
      stateEvents: cached?.stateEvents,
      suppressParticipationReplies: notification?.ui?.replies_muted,
    });
    directedCache.set(id, directed);
    return directed;
  }

  const classifier = filtering.makeClassifier({
    currentUserLogin,
    commentCache: { threads: commentThreads },
    deps: {
      notificationKey: getNotificationKey,
      isNotificationDirectedAtCurrentUser: isDirectedAtCurrentUser,
      isNotificationReviewResponsibility: commentStatus.isReviewResponsibility,
      isNotificationApproved: (notification) =>
        commentStatus.isApproved(notification, cachedFor(notification)),
      isNotificationChangesRequested: (notification) =>
        commentStatus.isChangesRequested(notification, cachedFor(notification)),
      getUninterestingReason: (notification) =>
        commentStatus.getUninterestingReason(notification, cachedFor(notification), {
          currentUserLogin,
        }),
    },
  });

  const classifications = notifications.map((notification) => {
    const id = notification?.id || getNotificationKey(notification);
    const isFeed = classifier.matchesView(notification, 'issues');
    return {
      id,
      is_feed: isFeed,
      is_review_queue: classifier.isNotificationReviewQueue(notification),
      is_synthetic_review_request:
        classifier.isSyntheticResponsibilityNotification(notification),
      is_directed_at_current_user: isDirectedAtCurrentUser(notification),
    };
  });

  return {
    total_count: notifications.length,
    current_user: currentUserLogin,
    feed_ids: classifications
      .filter((classification) => classification.is_feed)
      .map((classification) => classification.id),
    classifications,
  };
}

async function main() {
  const input = await readStdin();
  let payload;
  try {
    payload = JSON.parse(input || '{}');
  } catch (error) {
    throw new Error(`Invalid JSON on stdin: ${error.message}`);
  }
  process.stdout.write(`${JSON.stringify(classifyNotifications(payload), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`feed_digest_classify.js: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  classifyNotifications,
  getNotificationKey,
  getThread,
};
