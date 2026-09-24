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
      routeOutsidePytorchToReplies: false,
      replyDemotions: {},
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
    routeOutsidePytorchToReplies: Boolean(payload?.routeOutsidePytorchToReplies),
    // id -> updated_at of Replies candidates the LLM judged FYI.
    replyDemotions: payload?.replyDemotions || {},
  };
}

function classifyNotifications(payload) {
  const {
    notifications,
    commentThreads,
    currentUserLogin,
    routeOutsidePytorchToReplies,
    replyDemotions,
  } = normalizeInput(payload);
  const directedCache = new Map();

  function cachedFor(notification) {
    return getThread(commentThreads, notification);
  }

  function interestOptions(notification) {
    const cached = cachedFor(notification);
    return {
      authorLogin: cached?.authorLogin,
      comments: commentInterest.sortComments(cached?.comments || []),
      currentUserLogin,
      lastReadAt: cached?.lastReadAt,
      stateEvents: cached?.stateEvents,
      suppressParticipationReplies: notification?.ui?.replies_muted,
    };
  }

  function isDirectedAtCurrentUser(notification) {
    const id = notification?.id || getNotificationKey(notification);
    if (directedCache.has(id)) {
      return directedCache.get(id);
    }

    const directed = commentInterest.isNotificationDirectedAtCurrentUser(
      notification,
      interestOptions(notification)
    );
    directedCache.set(id, directed);
    return directed;
  }

  const makeClassifier = (demotions) => filtering.makeClassifier({
    notifications,
    replyDemotions: demotions,
    currentUserLogin,
    commentCache: { threads: commentThreads },
    routeOutsidePytorchToReplies,
    deps: {
      notificationKey: getNotificationKey,
      // Mirror notifications-comments.js: without this dep the classifier
      // falls back to "own PR or @-mention" and trashes every PR the user is
      // participating in, so the digest never triages or auto-dones them.
      isNotificationForCurrentUser: (notification) => {
        const cached = cachedFor(notification);
        return commentInterest.isNotificationForCurrentUser(notification, {
          authorLogin: cached?.authorLogin,
          comments: commentInterest.sortComments(cached?.comments || []),
          currentUserLogin,
        });
      },
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
  const classifier = makeClassifier(replyDemotions);
  const undemotedClassifier = makeClassifier({});

  // Rule-based Replies the LLM may demote to Feed. Forced outside-org replies
  // and finished delegated @claude tasks are always real replies.
  const replyCandidates = notifications
    .filter((notification) =>
      undemotedClassifier.matchesView(notification, 'pr-notifications') &&
      !undemotedClassifier.isTrashNotification(notification) &&
      !undemotedClassifier.isForcedOutsideOrgReply(notification) &&
      !commentInterest.hasUnreadDelegatedTaskCompletion(
        notification,
        interestOptions(notification)
      ))
    .map((notification) => ({
      id: notification?.id || getNotificationKey(notification),
      unread_comment_ids: commentInterest
        .getUnreadComments(notification, interestOptions(notification))
        .map((comment) => comment.id),
    }));

  const classifications = notifications.map((notification) => {
    const id = notification?.id || getNotificationKey(notification);
    const isFeed = classifier.matchesView(notification, 'issues');
    // The webapp auto-marks "trash" (low-priority: merge-machinery/bot-only
    // chatter, approved/closed noise) done on sync, so those never reach the
    // feed the user actually sees. The digest must mirror that or it surfaces
    // items the inbox already swept. See notifications-filtering.isTrash*.
    const isTrash = classifier.isTrashNotification(notification);
    return {
      id,
      is_feed: isFeed,
      is_trash: isTrash,
      is_review_queue: classifier.matchesView(notification, 'others-prs'),
      is_synthetic_review_request:
        classifier.isSyntheticResponsibilityNotification(notification),
      is_directed_at_current_user:
        classifier.isNotificationDirectedAtCurrentUser(notification),
      is_review_duplicate: classifier.isReviewQueueDuplicate(notification),
      is_reply_demoted: classifier.isReplyDemoted(notification),
    };
  });

  return {
    total_count: notifications.length,
    current_user: currentUserLogin,
    feed_ids: classifications
      .filter((classification) => classification.is_feed && !classification.is_trash)
      .map((classification) => classification.id),
    trash_ids: classifications
      .filter((classification) => classification.is_trash)
      .map((classification) => classification.id),
    // Real threads for PRs waiting in Reviews; the webapp marks these done
    // (cleanNeedsReviewFeedDuplicates) and so does the digest worker.
    review_duplicate_ids: classifications
      .filter((classification) => classification.is_review_duplicate)
      .map((classification) => classification.id),
    reply_candidates: replyCandidates,
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
