# ghsim

GitHub notification simulation and testing tool with a REST API server for accessing notification data that isn't available through GitHub's official API.

## Why This Exists

GitHub's REST API cannot distinguish between "Read" and "Done" notification states—both return identical JSON. The web UI also shows additional data (saved state, subject state, actors) not available via API. This project provides:

1. **HTML Parsing API** - Extracts structured data from GitHub's notifications HTML
2. **GitHub API Proxy** - Authenticated proxy to GitHub's REST and GraphQL APIs
3. **Test Flows** - Automation for testing notification behavior

## Quick Start

```bash
# Install dependencies
uv sync
uv run playwright install chromium

# Authenticate (opens browser for GitHub login)
uv run python -m ghsim.auth myaccount

# Provision API token (for GitHub API proxy)
uv run python -m ghsim.token myaccount --prod

# Start the API server
uv run python -m ghsim.api.server --account myaccount

# Open debug UI
open http://localhost:8000/app/
```

## API Server

The server provides three categories of endpoints:

### HTML Notifications API

Parses GitHub's notifications HTML page and returns structured JSON with data not available in the official API.

#### `GET /notifications/html/repo/{owner}/{repo}`

Fetch and parse notifications for a repository.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `owner` | path | Repository owner |
| `repo` | path | Repository name |
| `before` | query | Pagination cursor (from previous page) |
| `after` | query | Pagination cursor (from next page) |
| `fixture` | query | Path to HTML fixture file (for testing) |

**Response:**
```json
{
  "source_url": "https://github.com/notifications?query=repo:owner/repo",
  "generated_at": "2025-12-25T12:00:00Z",
  "repository": {
    "owner": "pytorch",
    "name": "pytorch",
    "full_name": "pytorch/pytorch"
  },
  "notifications": [
    {
      "id": "12345678",
      "unread": true,
      "reason": "subscribed",
      "updated_at": "2025-12-25T12:00:00Z",
      "subject": {
        "title": "Fix memory leak in autograd",
        "url": "https://github.com/pytorch/pytorch/pull/12345",
        "type": "PullRequest",
        "number": 12345,
        "state": "open",
        "state_reason": null
      },
      "actors": [
        {
          "login": "contributor",
          "avatar_url": "https://avatars.githubusercontent.com/u/123"
        }
      ],
      "ui": {
        "saved": false,
        "done": false
      }
    }
  ],
  "pagination": {
    "before_cursor": null,
    "after_cursor": "Y3Vyc29yOjI1",
    "has_previous": false,
    "has_next": true
  }
}
```

**Fields extracted from HTML (not available in GitHub API):**

| Field | Description |
|-------|-------------|
| `ui.saved` | Whether notification is bookmarked/saved |
| `ui.done` | Whether notification is marked as done |
| `subject.state` | Issue/PR state: `open`, `closed`, `merged`, `draft` |
| `subject.state_reason` | Close reason: `completed`, `not_planned`, `resolved` |
| `subject.number` | Issue/PR number |
| `actors` | List of users involved (with avatars) |

#### `GET /notifications/html/repo/{owner}/{repo}/timing`

Profile request timing breakdown.

**Response:**
```json
{
  "fetch_total_ms": 1200,
  "fetch_breakdown": {
    "new_page_ms": 45,
    "goto_ms": 1100,
    "wait_for_ms": 20,
    "content_ms": 30,
    "close_ms": 5
  },
  "parse_ms": 75,
  "total_ms": 1275,
  "notification_count": 25,
  "html_length": 790000
}
```

#### `GET /notifications/html/parse`

Parse an HTML fixture file directly (for testing).

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `fixture` | query | Path to HTML file (required) |
| `owner` | query | Repository owner (default: "unknown") |
| `repo` | query | Repository name (default: "unknown") |

### GitHub API Proxy

Proxies requests to GitHub's REST and GraphQL APIs with authentication. The token is loaded from `auth_state/{account}.token`.

#### `GET/POST/PUT/PATCH/DELETE /github/rest/{path}`

Proxy to GitHub REST API (`https://api.github.com/{path}`).

**Examples:**
```bash
# Get authenticated user
curl http://localhost:8000/github/rest/user

# List notifications
curl http://localhost:8000/github/rest/notifications

# Get a specific issue
curl http://localhost:8000/github/rest/repos/pytorch/pytorch/issues/12345

# Mark notification as read
curl -X PATCH http://localhost:8000/github/rest/notifications/threads/12345
```

#### `POST /github/graphql`

Proxy to GitHub GraphQL API.

**Example:**
```bash
curl -X POST http://localhost:8000/github/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ viewer { login name } }"}'
```

### Utility Endpoints

#### `GET /health`

Health check with fetcher status.

```json
{
  "status": "ok",
  "live_fetching": true,
  "account": "myaccount"
}
```

#### `GET /`

Redirects to `/app/` (debug UI) or returns API info.

## Server Options

```bash
python -m ghsim.api.server [options]

Options:
  --account, -a NAME   Account name for live GitHub fetching (required for live mode)
  --host HOST          Bind address (default: 127.0.0.1)
  --port, -p PORT      Bind port (default: 8000)
  --no-reload          Disable auto-reload on code changes
  --headed             Show browser window (for debugging)
```

## Authentication Setup

### 1. Browser Session (for HTML fetching)

```bash
# Opens browser for manual GitHub login
python -m ghsim.auth myaccount

# Headless mode (if session exists)
python -m ghsim.auth myaccount --headed
```

Session saved to `auth_state/myaccount.json`.

### 2. API Token (for REST/GraphQL proxy)

```bash
# Production token (repo + notifications scopes)
python -m ghsim.token myaccount --prod

# Test token (includes delete_repo scope)
python -m ghsim.token myaccount

# Show existing token
python -m ghsim.token myaccount --show
```

Token saved to `auth_state/myaccount.token`.

**Token Scopes:**

| Mode | Scopes |
|------|--------|
| `--prod` | `repo`, `notifications` |
| default | `repo`, `notifications`, `delete_repo` |

## Debug UI

Access at `http://localhost:8000/app/` when server is running.

Features:
- Shows authenticated GitHub user at top
- Form for testing `/notifications/html/repo/{owner}/{repo}` endpoint
- Remembers field values in localStorage
- Pretty-printed JSON response

## Test Flows

For testing notification behavior with two accounts:

```bash
# Basic notification test
python -m ghsim.run_flow basic owner_account trigger_account

# Read vs Done state test
python -m ghsim.run_flow read_vs_done owner_account trigger_account

# Pagination test (creates 30 notifications)
python -m ghsim.run_flow pagination owner_account trigger_account --num-issues 30
```

Options:
- `--headed` - Show browser window
- `--no-cleanup` - Keep test repo after run
- `--num-issues N` - Number of issues for pagination test

## Fixture Management

Test fixtures are curated HTML files for unit testing the parser.

```bash
# List available response files
python -m ghsim.fixtures list

# Update test fixtures from latest responses
python -m ghsim.fixtures update
```

Directories:
- `responses/` - Raw captures from flows (gitignored)
- `tests/fixtures/` - Curated test fixtures (checked in)

## Project Structure

```
ghsim/
├── api/
│   ├── app.py              # FastAPI application
│   ├── routes.py           # HTML notifications endpoints
│   ├── github_proxy.py     # REST/GraphQL proxy endpoints
│   ├── fetcher.py          # Playwright HTML fetcher
│   ├── models.py           # Pydantic response models
│   └── server.py           # CLI entry point
├── parser/
│   └── notifications.py    # HTML to JSON parser
├── auth.py                 # Browser session management
├── token.py                # API token provisioning
├── github_api.py           # REST API client
├── fixtures.py             # Fixture management CLI
├── run_flow.py             # Test flow runner
└── flows/                  # Test flow implementations

webapp/
└── index.html              # Debug UI

tests/
├── fixtures/               # HTML test fixtures
├── test_parser.py          # Parser unit tests
└── test_api.py             # API endpoint tests

auth_state/                 # Sessions and tokens (gitignored)
responses/                  # Flow captures (gitignored)
```

## API Response Models

### Subject States

| Type | States |
|------|--------|
| Issue | `open`, `closed` |
| PullRequest | `open`, `closed`, `merged`, `draft` |
| Discussion | `open`, `closed` |

### State Reasons

| State | Reasons |
|-------|---------|
| Issue closed | `completed`, `not_planned` |
| Discussion closed | `resolved` |

### Notification Reasons

Standard GitHub reasons: `subscribed`, `manual`, `author`, `comment`, `mention`, `team_mention`, `state_change`, `assign`, `review_requested`, `security_alert`, `ci_activity`

## Background

### The Problem

GitHub's REST API has limitations:

| State | `unread` field | Distinguishable? |
|-------|----------------|------------------|
| UNREAD | `true` | Yes |
| READ | `false` | No (identical to DONE) |
| DONE | `false` | No |

The GraphQL API has no notifications support (it was briefly added then removed in Jan 2025).

### The Solution

Parse the HTML notifications page which contains:
- Done/Saved state (via CSS classes and icons)
- Subject state (open/closed/merged via icons)
- Subject number
- Actor avatars
- Proper pagination cursors

This API extracts that data and returns it as structured JSON.
