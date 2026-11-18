# Design and internals — dsh-session-status-hub

> For maintainers. User documentation: [README.md](../README.md) (English) /
> [README.zh-CN.md](../README.zh-CN.md) (Chinese, full behaviour-level doc).
> The Chinese internals companion of this file is [design.zh-CN.md](design.zh-CN.md).

## State derivation

| State | Determined by |
|---|---|
| **failed** `error` | `hubTurnOutcome.outcome ∈ error / interrupted`, not yet acknowledged |
| **waiting** `answer` | `pendingInteraction.kind ∈ approval / plan-review / question` |
| **unread** `unread` | `completionUnread === true`, or the plugin's own "finished in background" record |
| **running** `running` | `sessionStatus.running`, or the Session row's `running` |
| **not started** `draft` | non-blank `draft.text` in `localStorage["dsh.conversation.<sessionId>"]`; the current main-view Session also reads `uiSession.current.hooks.input.draft` (ui-conversation's live composer draft) |
| **background jobs** `jobs` | the host-side aggregation still reports `running` / `stopping` jobs owned by that Session (`POST /dsh-session-status-hub/jobs`, polled every 5 s) |

> "Background jobs" is the only polled state (the other five are event-driven): a session's turn may
> have completed while its `run_in_background` jobs keep running. It classifies last as a fallback —
> waiting / failed / running / unread / not-started always outrank it — and never notifies or lights
> the taskbar. When the host half is an older build without the `/jobs` action, the client locks the
> fallback off and the state disappears silently until DSH is restarted into a matching version.

- Classification order is independent of display order: waiting > failed > running > unread > not
  started > background jobs. Drafts and background jobs never override any of the four established states.
- Gray and teal sit last on purpose: "not started" and "background jobs" are only reminders and must
  not take a top-3 slot away from failed / waiting / unread / running Sessions. When higher states fill
  the three default slots, drafts and job chips stay behind the `+N` expander.
- **Recent Sessions** is an approximation, not a "left the status group" event log: the client receives
  the *current* status snapshot, not an event stream, so "was failing a moment ago, now acknowledged" is
  indistinguishable from "idle all along" between two snapshots. The group is derived as "Sessions not in
  the status group, newest `updatedAt` first" — the Session you just read / acknowledged / finished /
  switched away from always sorts to the top, which is the same outcome. Nothing is persisted for it.
  Recent chips carry no state dot, use the secondary text colour, never notify, and never light the
  taskbar (taskbar aggregation only looks at the status group). A Session never appears in both groups.
- **Archived Sessions never show up in either group.** The archive set lives only in the workspace
  registry snapshot (`archivedSessionIds` — session list rows carry no "archived" flag), so both the rail
  (via `useWorkspaces`) and the taskbar aggregation filter against it.
- Blank "new session" rows are ignored only while they have no draft; once the composer holds unsent text
  they appear as "Not started". Subagent Sessions (`origin: subagent`) are still ignored.

### Why the plugin records unread state itself

The stock `ui-session` only sets `completionUnread` when a turn ends in a Session that is *not* the
main view — so "I was reading this conversation, switched to another app, the turn finished" produces
nothing: no dot, no taskbar mark, no rail chip. The plugin observes the same edge and, when the window
is not in the foreground, records the completion itself (`localStorage`
`dsh-session-status-hub/local-unread-v1`) so the green dot, the green taskbar mark and the 待查看 chip
all appear. It clears when you come back and look at that Session, or when you click its
notification/chip.

### Where "not started" comes from

`ui-conversation` persists every Session's composer draft under
`localStorage["dsh.conversation.<sessionId>"]` as `{"draft": "text"}` (legacy) or
`{"draft": {"text": "...", "references": [...]}}` (current). The plugin reads that key, trims
`draft.text`, and only keeps `{ chars }` — the draft body never enters plugin state, is never
persisted or sent anywhere, and is never rendered. Parsing never touches the DOM or the editor.

A blank "new Session" may not have a `dsh.conversation.<id>` key before its first message
(measured: 40 blank Sessions in an old store had none), so the current main-view Session also reads
the live input hook `uiSession.current.getSnapshot().hooks.input.getSnapshot().draft`. That hook is
what `ui-conversation` publishes for the composer, covers blank Sessions, and lets a cleared composer
remove the chip immediately without waiting for persistence. Only the trimmed length is kept; the text
is discarded.

The scan runs on `input`/`compositionend` (200 ms coalescing), on cross-tab `storage` events, and on
a 2 s poll while the page is visible; focus/visibility changes trigger one more scan. Sending the
message or clearing the composer removes the chip. Drafts do not notify, do not light the taskbar, and
do not auto-expire — the same lifecycle as DSH's own draft.

## Rail internals

- **Two groups on one line**, split by a vertical rule: **Status Sessions** (the six states above,
  3 visible + `+N`) and then **Recent Sessions** (up to 5, 3 visible + `+N`).
- **The rail has two layers**: an outer, **non-scrolling** fixed strip that holds the `‹` / `›`
  navigation buttons pinned at the left, and an inner `overflow-x: auto` chip scroller (both groups
  live there). Scrolling the chips all the way right never scrolls the navigation away.
- **The chips scroll with the wheel**: the inner scroller has its scrollbar hidden, and a mouse only
  has a vertical wheel — browsers do not convert that themselves. The outer fixed strip therefore
  carries a non-passive `wheel` listener (so the wheel works even over the nav buttons), and
  `hub-scroll`'s `wheelScrollDelta` reads the **inner scroller's** width and `scrollLeft` to turn
  vertical wheel movement into its `scrollLeft`. It does **not** swallow the event when nothing
  overflows, when the intent is horizontal (trackpad swipe / Shift+wheel), or when the end is already
  reached — so an ancestor scroll container still scrolls and nothing feels stuck.
- **Each group title is a toggle**: clicking `Status Sessions` / `Recent Sessions` folds its chips away
  (leaving the title plus a small item count), clicking again brings them back. The title carries a
  hand-drawn chevron — `⌄` expanded, rotated 90° to `›` when collapsed — plus `cursor: pointer`, a
  hover background and a `focus-visible` ring, so it reads as clickable. That is a different knob from
  `+N`: `+N` switches between "3 chips" and "all", the title switches "shown / hidden". Collapse state
  lives in component memory and resets on reload.

## Notification internals

**"Needs your response" stays on screen and carries its own "打开对话" button.** The Windows rule to
reason about first: a toast may only stay on screen (not auto-dismiss) if it carries at least one
action button. Without one, the platform silently appends a "Close" button (whatwg/notifications#236),
and activating that auto button comes back to the page as a `click` (`electron#27088`) — so "Close"
would also jump to the Session and raise the window, with the label and the behaviour contradicting
each other. The plugin therefore:

- keeps `requireInteraction` **on for the answer category only**: a question notification is worth
  exactly as much as its ability to be seen while you are away from the screen (0.4.1 briefly dropped
  it, and the toast sinking into the notification centre after a few seconds read as "notifications
  stopped popping"; restored in 0.5.x);
- provides the required button itself — `actions: [{ action: 'open-session', title: '打开对话' }]` — so
  clicking the button and clicking the body are the same `click`, both jump to the Session, while the
  native × in the corner still just closes. The shape is the **Web Notifications API** dictionary
  (`action` = activation id, `title` = button label): the Electron **main-process**
  `NotificationAction` shape (`{ type, text }`) makes the renderer's constructor throw a `TypeError`
  (missing `action` member), which on 2026-11-18 silently killed a batch of answer notifications at
  `construct-failed`. Two hard rules from that incident now live in the code: use the web shape, and
  whenever a construction **with** `actions` throws, retry once without them — a button is optional,
  the notification itself is not;
- leaves the other four categories non-persistent: they flash by and settle in the notification centre.

- Notification `tag`s are capped at 15 characters on purpose: a long `tag` makes Chromium drop the
  whole toast silently — the measured table is in the Chinese doc.
- Cross-tab dedupe window (`recent-v1`): 4 s. Landing results are kept in `notify-log-v1`
  (last 20). A short `tag` also lets a new toast displace the stale one for the same Session.

## Diagnostics

```js
__DSH_SESSION_HUB__.inspect()            // versions, services, focused, hostHalf, rows, taskbar, jobSessions, jobsRoute
__DSH_SESSION_HUB__.getRows()            // current rail rows
__DSH_SESSION_HUB__.getTaskbarState()    // red / yellow / green / none
__DSH_SESSION_HUB__.getDrafts()          // { [sessionId]: { chars } } — sessions with an unsent draft (counts only, no text)
__DSH_SESSION_HUB__.getRunningJobs()     // { [sessionId]: { count, label } } — sessions with live background jobs (count + first label only)
__DSH_SESSION_HUB__.refreshJobs()        // pull the job snapshot once right now, returns it (debugging)
__DSH_SESSION_HUB__.getLocalUnread()     // plugin-side "finished in background, unseen" records
__DSH_SESSION_HUB__.getNavHistory()      // { entries, index, canBack, canForward } — the history behind the ‹ › buttons
__DSH_SESSION_HUB__.getSettings()        // { showRecentSessions } — same snapshot as the detail-page settings block
__DSH_SESSION_HUB__.goBack()             // step back one Session (same path as the ‹ button)
__DSH_SESSION_HUB__.goForward()          // step forward one Session (same path as the › button)
__DSH_SESSION_HUB__.testNotification()   // fire a test toast; clicking it should jump back
__DSH_SESSION_HUB__.getLiveNotifications() // toasts still on screen / in Action Center that auto-dismissal can clear
__DSH_SESSION_HUB__.getNotifyLog()       // last 20 notification landing results
__DSH_SESSION_HUB__.pingHost()           // 'present' / 'absent' / 'unknown'
```

Host half, read-only:

```powershell
# The origin follows your DSH instance: whatever origin serves the page also serves these
# routes (the desktop shell forwards same-origin paths to the host). Example: the web UI at
# http://127.0.0.1:8779/.
$base = 'http://127.0.0.1:8779'
$h = @{ 'x-dsh-session-status-hub' = '1' }   # internal routes require the signature header (403 without it)
Invoke-RestMethod -Uri "$base/dsh-session-status-hub/ping"  -Method POST -Headers $h
Invoke-RestMethod -Uri "$base/dsh-session-status-hub/debug" -Method POST -Headers $h
```

Alongside `config-v1`, the plugin keeps a few state keys under the same prefix — worth knowing
when troubleshooting, migrating or wiping data:

| Key | Contents |
|---|---|
| `watermarks-v1` | notification watermarks: how far each Session has been consumed |
| `error-acks-v1` | acknowledged failures `{ sessionId: seq }` (what turns the red chip off) |
| `local-unread-v1` | plugin-recorded "finished in background, unseen" `{ sessionId: seq }` |
| `recent-v1` | cross-tab dedupe window (4 s) |
| `notify-log-v1` | last 20 notification landing results |

## Architecture

```
dsh-session-status-hub/
├── index.js                 host half: hubTurnOutcome projection + routes
├── lib/raise-window.js      host half: window raise + taskbar dot (resident PowerShell worker)
├── lib/client.js            client bundle (generated by build/bundle.mjs — do not edit)
├── src/hub-identity.js      plugin id / projection key / route prefix / signature header / storage keys (shared)
├── src/hub-strings.js       UI strings zh/en (single source)
├── src/hub-model.js         rail + taskbar logic (pure, unit-testable)
├── src/hub-history.js       Session visit history for the ‹ › navigation buttons (pure, unit-testable)
├── src/hub-drafts.js        unsent-draft read/normalize (pure, unit-testable)
├── src/notify-core.js       notification edge engine (pure, unit-testable)
├── src/hub-scroll.js        sidebar row reveal/scroll + reveal controller (unit-testable)
├── src/hub-json-store.js    localStorage JSON read/write (fallback on read, warn on write)
├── src/hub-stores.js        config / watermarks / error acks / background-completion records
├── src/hub-notify.js        notification landing: short tag, cross-tab dedupe, stale-toast dismissal, landing log
├── src/hub-host.js          host-half routes: raise window / taskbar state / liveness probe
├── src/hub-ui.js            React rail / row hint / detail-page settings components
├── src/hub-slots.js         slot registration
├── src/client-main.js       wiring: services → model → notifications / rail / taskbar
├── build/bundle.mjs         inlines src/ in order into one classic-script bundle
├── test/                    212 node:test cases, zero dependencies
├── locale/{zh,en}.json      plugin manager title and description
├── icon.svg                 plugin icon
├── cordis.patch.yml         bundle patch inserting the session-hub row
├── .github/workflows/ci.yml CI: bundle-in-sync check + full test run
└── LICENSE                  MIT
```

Why the plugin computes edges itself: DSH hands the client *current state*, not an event stream
(`running` is a boolean, `pendingInteraction` the current value, the projection the last turn's
outcome). Notifications therefore have to be derived from state edges, in exactly one implementation
(`planNotifications`), which also reports "this turn really ended" so the client can record unread
state the stock UI never sets for the main view.

Why failure detection needs the host half: the client cannot see *why* the previous turn ended.
`turn/end` carries `reason.kind`, but only for retained Sessions. A session projection is the
supported answer: the framework folds **all** Sessions (cold ones included), and the value reaches
the client through three supported channels. The plugin therefore retains no Session at all.

## Technical boundaries

- **Background jobs lag at most one poll cycle (5 s)**: a job that starts or settles between two polls
  appears on the next one; regaining window focus pulls an immediate refresh. On an older host half
  without the `/jobs` action the state disables itself silently (`inspect().jobsRoute === 'unsupported'`)
  and returns after DSH restarts into a matching version. The job snapshot exposes counts and the
  first job's label only — never job output.
- Sidebar scrolling relies on the official `data-row-key` convention; if upstream changes it,
  scrolling degrades silently (navigation is unaffected). `revealSessionRow(id)` returns `null` when
  that happens.
- **Archive filtering needs the workspace registry**: `archivedSessionIds` comes from the
  `useWorkspaces` snapshot for the rail, and from `uiWorkspace.workspaces.list` / `workspaces.list`
  for the taskbar aggregation. When neither is reachable (a custom composition without the Workspace
  UI) the plugin treats it as "nothing archived": the rail still renders and
  `__DSH_SESSION_HUB__.inspect().archivedSessions` returns `null` — a deliberate degradation, not a
  failure.
- "Not started" relies on ui-conversation's draft storage: key `dsh.conversation.<sessionId>`,
  value `{ draft: string | { text, references, command? } }`. Drafts with attachments but no text are
  not detected (the persisted draft has no text), and drafts do not auto-expire.

## Security internals

- **Naming**: repository, npm package, `cordis.patch.yml`'s `name`, the `window.__ModuleLoader__`
  registration id and `PLUGIN_ID` (route prefix, `localStorage` keys, log tags) are all
  `dsh-session-status-hub`; only the Cordis node id inside `cordis.patch.yml` keeps the short name
  `session-hub`.
- **Upgrading from 0.1.x**: the plugin id changed, so the `localStorage` prefix changed too; on
  startup the client half moves the old config / acks / records onto the new keys (never overwriting
  existing new data) and deletes the old ones.
- **Internal routes require a signature header**: every client request carries
  `x-dsh-session-status-hub: 1` and the host half only answers when it is present (403 otherwise).
  This is **not** authentication — it blocks *cross-site triggering*: a custom header turns a browser
  request into a preflighted cross-site request, and the host half returns no CORS headers, so a
  random web page that can POST to the local port never reaches the handler. `/raise` (bring the
  window forward) and `/warmup` (spawn the PowerShell worker) therefore cannot be triggered by
  arbitrary pages. The endpoints still only affect the window and the taskbar icon and return no user
  data (`/debug` returns projection keys, versions and process state; `/jobs` returns per-session job
  counts and command labels, never job output).
- **The signature header is version-gated**: host half and client half must be the same version or
  newer. An older client half (no header) is rejected by a newer host half, and the console says so
  explicitly ("missing signature header, reload the page to align").
- **The host half spawns one PowerShell process** (`-NoProfile -EncodedCommand`, no script file
  written, no execution-policy change). The worker script is in `lib/raise-window.js`;
  set `raiseWindow: false` to skip window raising.
