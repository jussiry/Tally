@AGENTS.md

## After a merge or deploy

Don't archive the session. Fast-forward this worktree's branch to the new `main`
(`git merge --ff-only main`) and keep working on it, so the next change starts
from everything other sessions have merged. Archive only when told the thread is done.

## Running and checking the app

`npm run dev` serves the app at http://localhost:3000 with auto-rebuild.

### Ports across worktrees

Several sessions may run at once, each in its own worktree. Start the app with
preview_start `Tally app`, which picks a free port when 3000 is taken. Use the
port it reports everywhere — `npm run peer -- --port <port> …`, and
`TEST_PORT=<free port>` for e2e runs — and never kill a server you did not start.
IndexedDB is per origin, so a new port starts empty: seed it again.

Use the **Browser pane tools** for UI checks. Never use the Chrome plugin on
localhost: it is the user's real browser and shares IndexedDB with the preview,
so it can corrupt the seeded state.

### Seed users

Three fixed identities with real keypairs, so they can genuinely connect:

| User  | Role | Starting state |
|-------|------|----------------|
| Alice | preview browser | Bob accepted, Carol pending incoming, an open request from Bob |
| Bob   | peer helper | Alice and Carol accepted |
| Carol | peer helper | Alice pending outgoing, Bob accepted |

Open `/?seed=<name>` to seed; it only applies to an empty IndexedDB, so open
`/?removeUser` first to switch users or start over.

### A second user

`npm run peer -- --user <bob|carol> --action <action> [args]` drives a headless
second user through one action and exits, without touching the preview's state.
Actions and arguments are listed in the header of `tests/peer-helper/run.cjs`;
`--headed` shows the browser.

### End-to-end tests

`node tests/two-client-e2e/run.cjs --scenario <name>` runs full browser clients
against a dedicated server on **port 3001** — stop `devAll` first, whose landing
site uses the same port. Scenarios live in `tests/two-client-e2e/scenarios/`;
register new ones in `run.cjs`.
