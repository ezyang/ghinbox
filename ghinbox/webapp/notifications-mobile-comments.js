// Review comment expansion and mobile tap-to-expand behavior.
(function () {
    const COMMENT_EXPAND_REVIEWS_KEY = 'ghnotif_comment_expand_reviews';
    const reviewsToggle = document.getElementById('comment-expand-reviews-toggle');

    state.commentExpandReviews = localStorage.getItem(COMMENT_EXPAND_REVIEWS_KEY) !== 'false';
    elements.commentExpandReviewsToggle = reviewsToggle;

    if (reviewsToggle) {
        reviewsToggle.checked = state.commentExpandReviews;
        reviewsToggle.addEventListener('change', (event) => {
            state.commentExpandReviews = event.target.checked;
            localStorage.setItem(COMMENT_EXPAND_REVIEWS_KEY, String(state.commentExpandReviews));
            render();
        });
    }

    function getCommentExpansionOverride(notification) {
        if (isMobileViewport()) {
            const itemExpanded = state.commentBodyExpanded.has(notification.id);
            return itemExpanded;
        }
        if (state.view === 'others-prs') {
            return Boolean(state.commentExpandReviews);
        }
        return null;
    }

    function shouldIgnoreMobileToggle(event) {
        return Boolean(
            event.target.closest('a, button, input, label, select, textarea')
        );
    }

    function enhanceMobileCommentToggles() {
        document.querySelectorAll('.notification-item').forEach((item) => {
            const notificationId = item.getAttribute('data-id');
            if (!notificationId) {
                return;
            }
            const expanded = state.commentBodyExpanded.has(notificationId);
            item.classList.toggle('mobile-expanded', expanded);
            item.setAttribute('aria-expanded', String(expanded));
            if (item.dataset.mobileCommentToggleBound) {
                return;
            }
            item.dataset.mobileCommentToggleBound = '1';
            item.addEventListener('click', (event) => {
                if (
                    !isMobileViewport() ||
                    state.mobileSelectMode ||
                    shouldIgnoreMobileToggle(event)
                ) {
                    return;
                }
                const id = item.getAttribute('data-id');
                if (!id) {
                    return;
                }
                if (state.commentBodyExpanded.has(id)) {
                    state.commentBodyExpanded.delete(id);
                } else {
                    state.commentBodyExpanded.add(id);
                }
                render();
            });
        });
        if (reviewsToggle) {
            reviewsToggle.checked = state.commentExpandReviews;
        }
    }

    registerRenderHook(enhanceMobileCommentToggles);
    globalThis.getCommentExpansionOverride = getCommentExpansionOverride;
})();
