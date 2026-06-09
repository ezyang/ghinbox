// Bookmark and "move participation replies to Feed" notification controls.
(function () {
    const bookmarkIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 2.75C3 1.784 3.784 1 4.75 1h6.5c.966 0 1.75.784 1.75 1.75v11.5a.75.75 0 0 1-1.227.579L8 11.722l-3.773 3.107A.751.751 0 0 1 3 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.91l3.023-2.489a.75.75 0 0 1 .954 0l3.023 2.49V2.75a.25.25 0 0 0-.25-.25Z"></path></svg>';
    const bookmarkFilledIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 2.75C3 1.784 3.784 1 4.75 1h6.5c.966 0 1.75.784 1.75 1.75v11.5a.75.75 0 0 1-1.227.579L8 11.722l-3.773 3.107A.75.75 0 0 1 3 14.25Z"></path></svg>';
    const moveToFeedIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 2A1.75 1.75 0 0 0 1 3.75v8.5C1 13.216 1.784 14 2.75 14h10.5A1.75 1.75 0 0 0 15 12.25v-8.5A1.75 1.75 0 0 0 13.25 2Zm0 1.5h10.5a.25.25 0 0 1 .25.25v1.5h-11v-1.5a.25.25 0 0 1 .25-.25Zm-.25 3.25h4v5.75H2.75a.25.25 0 0 1-.25-.25Zm5.5 5.75V6.75h5.5v5.5a.25.25 0 0 1-.25.25Z"></path></svg>';

    function isBookmarked(notification) {
        return Boolean(notification?.ui?.bookmarked);
    }

    function currentBookmarkFilter() {
        const filters = state.viewFilters[state.view] || DEFAULT_VIEW_FILTERS[state.view] || {};
        return filters.bookmark || 'new';
    }

    async function putNotificationLocalState(notificationId, path, body) {
        const notification = state.notifications.find((item) => item.id === notificationId);
        const repo = getNotificationRepoInfo(notification) ||
            parseRepoInput(state.repo || elements.repoInput.value.trim());
        if (!repo) {
            throw new Error('Invalid repository');
        }
        const response = await fetch(
            `/notifications/html/repo/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/${path}/${encodeURIComponent(notificationId)}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }
        );
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
                typeof errorData.detail === 'string' ? errorData.detail : `HTTP ${response.status}`
            );
        }
        return response.json();
    }

    function setBookmarkState(notificationId, bookmarked) {
        return putNotificationLocalState(notificationId, 'bookmarks', { bookmarked });
    }

    function setRepliesMutedState(notificationId, repliesMuted) {
        return putNotificationLocalState(notificationId, 'replies-muted', {
            replies_muted: repliesMuted,
        });
    }

    async function handleBookmarkClick(notificationId, button) {
        const notification = state.notifications.find((item) => item.id === notificationId);
        if (!notification) {
            return;
        }
        button.disabled = true;
        const previous = isBookmarked(notification);
        const next = !previous;
        notification.ui = { ...(notification.ui || {}), bookmarked: next };
        persistNotifications();
        render();
        try {
            await setBookmarkState(notificationId, next);
            showStatus(next ? 'Bookmarked' : 'Bookmark removed', 'success', {
                autoDismiss: true,
            });
        } catch (error) {
            notification.ui = { ...(notification.ui || {}), bookmarked: previous };
            persistNotifications();
            showStatus(`Bookmark failed: ${error.message || error}`, 'error');
        } finally {
            render();
        }
    }

    async function handleMoveToFeedClick(notificationId, button) {
        const notification = state.notifications.find((item) => item.id === notificationId);
        if (!notification) {
            return;
        }
        button.disabled = true;
        const previous = Boolean(notification.ui?.replies_muted);
        notification.ui = { ...(notification.ui || {}), replies_muted: true };
        persistNotifications();
        render();
        try {
            await setRepliesMutedState(notificationId, true);
            showStatus('Moved participation replies to Feed', 'success', {
                autoDismiss: true,
            });
        } catch (error) {
            notification.ui = { ...(notification.ui || {}), replies_muted: previous };
            persistNotifications();
            showStatus(`Move to Feed failed: ${error.message || error}`, 'error');
        } finally {
            render();
        }
    }

    function shouldShowMoveToFeed(notification) {
        if (
            state.view !== 'pr-notifications' ||
            state.view === 'cleaned' ||
            notification?.ui?.replies_muted ||
            !safeIsNotificationDirectedAtCurrentUser(notification)
        ) {
            return false;
        }
        const cached = state.commentCache.threads[getNotificationKey(notification)];
        return !COMMENT_INTEREST.isNotificationDirectedAtCurrentUser(notification, {
            authorLogin: cached?.authorLogin,
            comments: getSortedNotificationComments(notification),
            currentUserLogin: state.currentUserLogin,
            lastReadAt: cached?.lastReadAt,
            suppressParticipationReplies: true,
        });
    }

    function makeMoveToFeedButton(notification, bottom) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = bottom
            ? 'notification-move-feed-btn notification-move-feed-btn-bottom'
            : 'notification-move-feed-btn';
        button.setAttribute('aria-label', 'Move participation replies to Feed');
        button.title = 'Move participation replies to Feed';
        button.innerHTML = moveToFeedIcon;
        if (bottom) {
            const label = document.createElement('span');
            label.textContent = 'Move to Feed';
            button.appendChild(label);
        }
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            withActionContext('Move to Feed (inline)', () =>
                handleMoveToFeedClick(notification.id, button)
            );
        });
        return button;
    }

    function makeBookmarkButton(notification, bottom) {
        const bookmarked = isBookmarked(notification);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = bottom
            ? 'notification-bookmark-btn notification-bookmark-btn-bottom'
            : 'notification-bookmark-btn';
        if (bookmarked) {
            button.classList.add('is-bookmarked');
        }
        const labelText = bookmarked ? 'Remove bookmark' : 'Bookmark notification';
        button.setAttribute('aria-label', labelText);
        button.title = labelText;
        button.innerHTML = bookmarked ? bookmarkFilledIcon : bookmarkIcon;
        if (bottom) {
            const label = document.createElement('span');
            label.textContent = bookmarked ? 'Unbookmark' : 'Bookmark';
            button.appendChild(label);
        }
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            withActionContext('Bookmark (inline)', () =>
                handleBookmarkClick(notification.id, button)
            );
        });
        return button;
    }

    function syncBookmarkTabClass() {
        document
            .querySelectorAll('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="bookmark"] .subfilter-tab')
            .forEach((tab) => {
                const active = state.view === 'issues' &&
                    currentBookmarkFilter() === tab.dataset.subfilter;
                tab.classList.toggle('bookmark-active', active);
            });
    }

    function enhanceNotificationControls() {
        syncBookmarkTabClass();
        document.querySelectorAll('.notification-item').forEach((item) => {
            if (item.querySelector('.notification-bookmark-btn')) {
                return;
            }
            const notificationId = item.getAttribute('data-id');
            const notification = state.notifications.find((entry) => entry.id === notificationId);
            if (!notification || state.view === 'cleaned') {
                return;
            }
            const inlineActions = item.querySelector('.notification-actions-inline');
            if (inlineActions) {
                const doneButton = inlineActions.querySelector('.notification-done-btn');
                if (shouldShowMoveToFeed(notification)) {
                    inlineActions.insertBefore(
                        makeMoveToFeedButton(notification, false),
                        doneButton || inlineActions.children[1] || null
                    );
                }
                inlineActions.insertBefore(
                    makeBookmarkButton(notification, false),
                    doneButton || inlineActions.children[1] || null
                );
            }
            const bottomActions = item.querySelector('.notification-actions-bottom');
            if (bottomActions) {
                const doneButton = bottomActions.querySelector('.notification-done-btn-bottom');
                if (shouldShowMoveToFeed(notification)) {
                    bottomActions.insertBefore(makeMoveToFeedButton(notification, true), doneButton || null);
                }
                bottomActions.insertBefore(makeBookmarkButton(notification, true), doneButton || null);
            }
        });
    }

    registerRenderHook(enhanceNotificationControls);
})();
