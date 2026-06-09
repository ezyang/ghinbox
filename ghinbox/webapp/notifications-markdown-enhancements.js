// Markdown and rendered-comment post-processing helpers.
(function () {
    const CACHE_BUST_KEY =
        globalThis.GhinboxViewState?.STORAGE_KEYS?.cacheBust || 'ghnotif_cache_bust';

    function collapseVersionsSection(markdown) {
        const text = String(markdown ?? '');
        const lines = text.split('\n');
        const output = [];
        let changed = false;
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            const match = line.match(/^(#{1,6})\s+Versions\s*$/i);
            if (!match) {
                output.push(line);
                i += 1;
                continue;
            }
            const level = match[1].length;
            let j = i + 1;
            while (j < lines.length) {
                const headingMatch = lines[j].match(/^(#{1,6})\s+.+$/);
                if (headingMatch && headingMatch[1].length <= level) {
                    break;
                }
                j += 1;
            }
            const sectionLines = lines.slice(i + 1, j);
            output.push('<details class="collapsed-versions">');
            output.push('<summary>Versions</summary>');
            if (sectionLines.length > 0) {
                output.push('');
                output.push(...sectionLines);
            }
            output.push('</details>');
            changed = true;
            i = j;
        }
        return changed ? output.join('\n') : text;
    }

    function wrapRenderMarkdown() {
        if (typeof renderMarkdown !== 'function') {
            return;
        }
        const original = renderMarkdown;
        globalThis.renderMarkdown = function (text) {
            return original(collapseVersionsSection(text));
        };
    }

    function collapseCodeBlocks(root) {
        const mobileQuery = window.matchMedia('(max-width: 640px)');
        const codeCollapseThreshold = 400;
        if (!mobileQuery.matches) {
            return;
        }
        const pres = (root || document).querySelectorAll('.comment-body pre');
        pres.forEach((pre) => {
            if (pre.dataset.codeCollapsible) {
                return;
            }
            pre.dataset.codeCollapsible = '1';
            requestAnimationFrame(() => {
                if (pre.scrollHeight <= codeCollapseThreshold) {
                    return;
                }
                pre.classList.add('code-collapsible', 'code-collapsed');
                const btn = document.createElement('button');
                btn.className = 'code-expand-btn';
                btn.textContent = 'Expand code';
                btn.addEventListener('click', () => {
                    const isCollapsed = pre.classList.toggle('code-collapsed');
                    btn.textContent = isCollapsed ? 'Expand code' : 'Collapse code';
                });
                pre.parentNode.insertBefore(btn, pre.nextSibling);
            });
        });
    }

    function observeCodeBlocks() {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (
                        node.nodeType === 1 &&
                        (node.classList?.contains('comment-body') ||
                            node.querySelector?.('.comment-body'))
                    ) {
                        collapseCodeBlocks(node.closest?.('.comment-item') || node);
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        collapseCodeBlocks();
    }

    function bindForceRefreshButton() {
        const forceRefreshBtn = document.getElementById('force-refresh-btn');
        if (!forceRefreshBtn) {
            return;
        }
        forceRefreshBtn.addEventListener('click', () => {
            const cacheBust = Date.now().toString();
            localStorage.setItem(CACHE_BUST_KEY, cacheBust);
            const url = new URL(window.location.href);
            url.searchParams.set('cache_bust', cacheBust);
            window.location.replace(url.toString());
        });
    }

    wrapRenderMarkdown();
    observeCodeBlocks();
    bindForceRefreshButton();
})();
