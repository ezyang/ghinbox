# The Soul of ghinbox

This is the project's constitution: the small set of ideas that predict how
things are done here, so they are done one way and not another. It is
aspirational — the code does not always live up to it — but when code and soul
disagree, build toward the soul.

The mnemonic: **Cache GitHub, never fork it. Logic in pure modules. Fixtures
from reality. Tests are the spec.**

## 1. GitHub is the database

ghinbox stores no truth of its own. Everything local — the IndexedDB caches,
the SQLite snapshot store, localStorage — is a disposable materialized view of
GitHub. Actions the user takes (mark done, unsubscribe) translate into
concepts GitHub already knows. You can delete all local state without losing
anything that matters.

**Why:** This is what lets the project survive its own churn. The UI premise
has been rebuilt and the deployment story has changed; neither required a data
migration, because there is no data to migrate.

**Predicts:**
- A new feature is designed in this order: (1) express it as a GitHub action;
  (2) failing that, as a cache rebuildable from GitHub; (3) only as a last
  resort, as local-only state.
- Local-only state is permitted only where GitHub has no vocabulary for the
  concept (bookmarks, read-comment watermarks, replies-muted) — and even then
  it must remain losable without grief.
- Schema changes drop and rebuild; we do not write migration machinery.

## 2. The server is a prosthesis, not a brain

The Python server exists only where the browser cannot go: scraping the
notifications HTML for state the API hides (Done vs Read, saved,
merged/draft), holding credentials and proxying REST/GraphQL, performing
actions only the website supports, and keeping a snapshot so startup doesn't
hammer GitHub. All product judgment — which queue a notification belongs to,
which comments matter, what needs review — lives in the client.

**Predicts:**
- When placing code, ask: *could the browser do this against GitHub's API?*
  If yes, it's JavaScript. The server grows only when GitHub's API fails you,
  and each server feature should be able to name the hole it fills.
- If GitHub ever exposes Done state through its API, the corresponding
  scraping code gets deleted, not kept.

## 3. One state object rendered whole; decisions ratchet into pure modules

The client is vanilla JS: no framework, no build step, no event bus, no
virtual DOM. A fixed row of `<script>` tags loads in dependency order; there
is one global `state` object; mutations are followed by a full `render()`.

Comprehensibility comes not from abstraction but from a one-way ratchet: any
*decision* logic — queue classification, filtering, comment interest, cache
freshness, comment windowing — gets extracted into a DOM-free UMD module
(`Ghinbox*`) that also runs under Node, with table-driven unit tests in
`e2e/unit/`. DOM-touching files keep only wiring.

The large DOM-entangled files (`notifications-core.js`, `notifications-ui.js`,
`notifications-actions.js`) are a digestion backlog, not a destination. Their
only legitimate future is shrinking.

**Predicts:**
- A new triage rule lands as: a pure function in a `Ghinbox*` module, a Node
  table test over its cases, and exactly one Playwright test proving the DOM
  wiring. Never a Playwright loop over logic cases.
- Complexity problems are solved by extraction, never by adopting a
  framework, bundler, or event system.
- If you cannot unit-test a decision without a browser, the decision is in
  the wrong file.

## 4. Fixtures are harvested, not invented

Test data is captured from reality: scripted flows (`ghinbox/flows/`) drive
real GitHub with test accounts, captures land in `responses/`, and the
fixtures CLI (`python -m ghinbox.fixtures`) freezes them into
`tests/fixtures/` and regenerates `e2e/fixtures/`. Hand-written fixtures are
tolerated only where determinism is the point (exact counts, fixed IDs).

**Why:** ghinbox sits on unstable ground — undocumented HTML. Invented
fixtures encode our guesses about GitHub; harvested fixtures encode GitHub.
When GitHub changes, a flow re-run regenerates the fixture; a hand-written
one just rots.

**Predicts:**
- Needing new test data means writing or running a flow, not authoring JSON.
- Flows double as a tripwire: when GitHub changes its UI, flows break before
  users do.

## 5. Tests are the spec

No human wrote or reviewed this code; it was built by a stream of prompts to
coding agents, and the prompts are gone. The only durable statement of intent
is behavior pinned by tests — which is why the E2E suite is larger than the
application. Code is fungible; the test suite is the project.

**Predicts:**
- Bug fixes start with a failing E2E test; features ship with one.
- Refactors preserve tests, not code shape. Rewriting a module is cheap;
  weakening a test is expensive and needs justification.
- When intent is ambiguous, the order of authority is: the tests, then this
  document, then the current code.

## Using this document

When making a change, find the axiom that governs it:

| Decision | Axiom |
|---|---|
| Where should this state live? | 1 — GitHub, else a rebuildable cache |
| Client or server? | 2 — server only for API holes |
| Where does this logic go? | 3 — a pure module, if it decides anything |
| How do I test it? | 3 + 5 — table test for logic, one E2E for wiring |
| Where does test data come from? | 4 — run a flow |

If a change has no governing axiom, that may mean the soul needs amending —
amend it deliberately, in this file, rather than silently in code.
