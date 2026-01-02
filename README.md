# ghinbox

A better UI for GitHub notifications.  Forged from the fires of PyTorch.

<img width="1192" height="725" alt="image" src="https://github.com/user-attachments/assets/ba24d830-b413-4fb4-b07c-56e38e9eddbf" />

The three main design philosophies of ghinbox are as follows:

1. **Pull more data, but less often.**  GitHub notifications allows only a very impoverished set of search queries and forces a strict limit of 25 items per page; in return, you can freely refresh your notifications without being rate limited.  ghinbox makes the opposite tradeoff: we want all of the notifications and all of the data; to avoid being rate-limited, you must explicitly request a sync and we expect you to only do syncs rarely, opting to show you our offline view of the state of notifications.

2. **Issue and pull request notifications are fundamentally different.**  GitHub notifications jumble issues and pull requests together.  We argue the workflow for handling issues and pull requests is quite different: issues you can just read, perhaps dash off a quick response; a pull request, you have to actually sit down and fully understand what is changed.  Issues you can doomscroll on your phone; pull requests require focused attention.  You should have separate flows for handling each of them.

3. **Core contributor PRs privileged over external contributor PRs.**  GitHub notifications doesn't distinguish between PRs that come from core contributors versus external contributors; anyone can CC you and dump a PR in your inbox.  This design makes it easy for the masses to hijack maintainer attention.  Instead, external contributions should be relegated to their own section, where a maintainer can engage with them on their own terms, subject to whatever attention they want to allocate.

These philosophies transfer into the following feature set:

* GitHub source of truth (unlike Octobox); you can blow away ghinbox's local state without care, any actions you take translate directly into concepts GitHub knows, like marking a notification as Done.

* Fetch all unread comments for each notification and display them inline on one page.

* Ability to filter out uninteresting comments (e.g., bot interactions, automated messages, etc.)

* Ability to take out notifications which were only induced by uninteresting actions.

* A Phabricator-style PR review dashboard, which emphasizes clarity on whether or not a PR in your inbox needs action taken on it or not.

## Technical details

GitHub's official API does not expose enough information / interaction points to implement even a feature-parity notifications page.  In particular:

* There is no way to distinguish between "Read" and "Done" notification states via the REST API.
* The HTML notifications page provides more information than the notifications JSON API provides.
* There is no way to move a notification back to inbox after it's marked done.

To work around these issues, ghinbox isn't just an HTML+JS application that hits the GitHub API; it comes with a full API server which provides a few extra APIs that stock GitHub API doesn't have, which are implemented by directly interacting with the GitHub website with Playwright.

Importantly, this means that I will not host ghinbox publicly; you have to run it yourself.  When you launch the server, it will launch a flow to log you into GitHub on Playwright's Chrome instance, and then will use that to issue itself a token (we also proxy plain GitHub API calls through this server so you don't have to provide a token in the web UI) and preserve the browser credentials so that it can do direct interactions.

This repository also contains support for "prod flows", which are scripted interactions against the real GitHub website (using test accounts), which we can use to get fixtures for our E2E tests and also verify that GitHub hasn't changed its UI in a way that is incompatible with our Playwright scripts.

## Quick Start

```bash
# Install dependencies
uv sync
uv run playwright install chromium

uv run ghinbox
```

## Contributing

See CONTRIBUTING.md
