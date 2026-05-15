# Production Query Recipes

These commands are for inspecting a running production ghinbox instance without
opening the browser UI. They are intended for debugging and UI workshop sessions.

Agents and local shells on the server host should prefer the Unix domain socket
debug listener. It is HTTP-shaped, bypasses the site password gate, and is
protected by filesystem permissions:

```bash
export GHINBOX_BASE=http://ghinbox
export GHINBOX_CURL_SOCKET="--unix-socket auth_state/ghinbox-debug.sock"

curl -sS ${GHINBOX_CURL_SOCKET} "${GHINBOX_BASE}/debug/state" | jq .
curl -sS ${GHINBOX_CURL_SOCKET} "${GHINBOX_BASE}/github/rest/user" |
  jq '{login, name}'
```

Do not proxy `auth_state/ghinbox-debug.sock` through nginx or expose it
remotely. If the socket is unavailable, use the site password flow below.

Set the base URL and authenticate through the site password gate:

```bash
export GHINBOX_BASE=http://127.0.0.1:8000
export GHINBOX_SITE_PASSWORD='...'

curl -sS -c /tmp/ghinbox_cookies \
  -d "password=${GHINBOX_SITE_PASSWORD}&next=/" \
  "${GHINBOX_BASE}/site-auth/login" >/dev/null
```

## Server Status

Check that the instance is production mode with live GitHub fetching:

```bash
curl -sS "${GHINBOX_BASE}/health" | jq .
```

Check the GitHub account used by REST and GraphQL proxy calls:

```bash
curl -sS -b /tmp/ghinbox_cookies \
  "${GHINBOX_BASE}/github/rest/user" |
  jq '{login, name}'
```

## Snapshot State

Read the server-side snapshot for a repository:

```bash
repo=pytorch/pytorch
owner=${repo%/*}
name=${repo#*/}

curl -sS -b /tmp/ghinbox_cookies \
  "${GHINBOX_BASE}/api/snapshots/${owner}/${name}" |
  jq '{
    repo: .repository.full_name,
    sync: .sync,
    snapshot: (
      .snapshot |
      if . then {
        synced_at,
        generated_at,
        source_url,
        notifications_count: (.notifications | length)
      } else null end
    )
  }'
```

Start a full server sync and poll its result:

```bash
curl -sS -b /tmp/ghinbox_cookies \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"mode":"full"}' \
  "${GHINBOX_BASE}/api/snapshots/${owner}/${name}/sync" |
  jq .

curl -sS -b /tmp/ghinbox_cookies \
  "${GHINBOX_BASE}/api/snapshots/${owner}/${name}/sync" |
  jq '{sync: .sync, notifications_count: (.snapshot.notifications | length)}'
```

## PR Notifications

The UI's `PR Notifications` view is:

- `subject.type == "PullRequest"`
- not a synthetic review-request responsibility item
- not a PR authored by the current user

This query shows the raw PR notification candidates from the snapshot:

```bash
curl -sS -b /tmp/ghinbox_cookies \
  "${GHINBOX_BASE}/api/snapshots/${owner}/${name}" |
  jq '
    .snapshot.notifications
    | map(select(
        .subject.type == "PullRequest"
        and (.responsibility_source != "review-requested")
      ))
    | map({
        id,
        reason,
        updated_at,
        number: .subject.number,
        state: .subject.state,
        title: .subject.title,
        actors: [.actors[]?.login]
      })
  '
```

Review requests assigned to the current GitHub user are fetched separately and
merged into snapshots as synthetic responsibility notifications:

```bash
curl -sS -b /tmp/ghinbox_cookies -G \
  --data-urlencode "q=repo:${owner}/${name} is:pr is:open user-review-requested:@me -review:approved" \
  --data-urlencode "per_page=100" \
  "${GHINBOX_BASE}/github/rest/search/issues" |
  jq '{total_count, items: [.items[] | {
    number,
    title,
    author: .user.login,
    updated_at,
    draft,
    url: .html_url
  }]}'
```

## PR Notifications > For You

The `For you` subfilter is not fully represented by the snapshot alone. The UI
classifies a PR notification as `For you` when one of these is true:

- the notification reason is `mention`
- the notification reason is `author`
- the PR author is the current GitHub user, using prefetched PR metadata
- a new issue or review comment mentions the current user
- a new issue or review comment replies in a thread where the current user has
  already participated

A useful snapshot-only approximation is:

```bash
curl -sS -b /tmp/ghinbox_cookies \
  "${GHINBOX_BASE}/api/snapshots/${owner}/${name}" |
  jq '
    .snapshot.notifications
    | map(select(
        .subject.type == "PullRequest"
        and (.responsibility_source != "review-requested")
        and ((.reason | ascii_downcase) == "mention"
          or (.reason | ascii_downcase) == "author")
      ))
    | map({
        reason,
        updated_at,
        number: .subject.number,
        title: .subject.title,
        url: .subject.url
      })
  '
```

For exact inspection of a candidate, fetch the issue and review comments that
the UI also uses for comment-cache classification:

```bash
number=183541

curl -sS -b /tmp/ghinbox_cookies \
  "${GHINBOX_BASE}/github/rest/repos/${owner}/${name}/issues/${number}/comments" |
  jq '[.[] | {id, user: .user.login, created_at, updated_at, body}]'

curl -sS -b /tmp/ghinbox_cookies \
  "${GHINBOX_BASE}/github/rest/repos/${owner}/${name}/pulls/${number}/comments" |
  jq '[.[] | {
    id,
    user: .user.login,
    created_at,
    updated_at,
    in_reply_to_id,
    path,
    body
  }]'
```

If this becomes a frequent workflow, add a read-only endpoint that projects
`/api/snapshots/{owner}/{repo}` through the same view and subfilter functions as
the browser UI. That endpoint should return both the matching notifications and
the counts for each visible tab.
