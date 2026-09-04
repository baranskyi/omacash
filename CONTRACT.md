# Data contracts — single source of truth

Both the Python CLI and the QML/JS frontend MUST conform to this file exactly.
If something here conflicts with any other document, THIS file wins.

## Identifiers

- Plugin id: `io.github.baranskyi.omacash`
- CLI file: `bin/omacash` (invoked as `/usr/bin/env python3 <pluginDir>/bin/omacash …`)
- Provider ids (fixed, used everywhere — config, cache, snapshot):
  `openrouter`, `vercel-ai`, `elevenlabs`, `openai-api`, `anthropic-api`
- State dir: `~/.local/state/omarchy/io.github.baranskyi.omacash/`
  (`config.json`, `secrets.json`, `cache/<id>.json`, `snapshot.json`, `alerts.json`, `lock` — every
  one of them 0600, in a 0700 dir; see "State directory safety")
- Omarchy's agents-usage dir, `~/.local/state/omarchy/agents/usage/`: this plugin never writes
  there; it only unlinks `<provider-id>.json` records that versions up to 0.1.0 left behind
  (see "Leftover agents records")
- Respect `XDG_STATE_HOME` (fallback `~/.local/state`) in the CLI. The QML side MUST NOT derive,
  name, or open any state path: it holds no state directory constant, calls no `Quickshell.env`,
  uses no `FileView`, and creates no directory. The CLI is the only reader and writer of the
  state directory; QML receives content exclusively as the stdout of a CLI process it spawned.

## snapshot.json  (written atomically by CLI `sync`; printed on stdout by `sync`/`status`; parsed in QML from that stdout only)

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-28T15:50:00Z",
  "totalRemainingUsd": "118.90",
  "anyEstimated": true,
  "attention": "openrouter",
  "providers": [
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "status": "ok",
      "source": "credits",
      "balance": { "remaining": "23.40", "funded": "120.00", "spent": "96.60",
                   "currency": "USD", "estimated": false },
      "percentRemaining": 0.195,
      "severity": "low",
      "resetsAt": null,
      "ledgerSince": null,
      "detail": "$96.60 used of $120.00",
      "fetchedAt": "2026-08-28T15:49:58Z",
      "stale": false,
      "error": null,
      "hint": null
    }
  ]
}
```

Rules:
- Money amounts in **snapshot** are **decimal strings** ("23.40"). `percentRemaining` is a JSON number 0..1 or null. ElevenLabs `balance.currency` is `"credits"` and its amounts are integer strings ("71000").
- `status` ∈ `ok | error | unconfigured`. `severity` ∈ `ok | low | critical | unknown`.
- `source` ∈ `credits | key-limit | subscription | ledger`.
- `error` is null or `{ "kind": "auth|network|http|config|unit-suspect|stale-expired", "message": "...", "hint": "..." }`. `hint` (top-level) is only for `unconfigured` rows. Hints/authHelpText spell out the full invocation, `"python3 " + abspath(CLI)` (e.g. "Run: python3 <pluginDir>/bin/omacash key set openrouter"), since bare `omacash` is not on PATH.
- `stale:true` = showing last-good data after a failed refresh; kept ≤ 7 days, then `balance:null` + error kind `stale-expired`.
- `estimated:true` on ledger-derived balances (openai-api, anthropic-api) and on any value the CLI computed rather than read.
- `totalRemainingUsd`: sum of USD `remaining` over ready providers only (credits excluded); decimal string; `"0.00"` if none. `anyEstimated`: any summed entry estimated.
- `attention`: provider id with the worst severity (critical > low), ties broken by lowest percentRemaining; null when all ok/unknown.
- Severity thresholds (config-overridable): low if percentRemaining < 0.20 OR remaining < $10; critical if < 0.05 OR < $3. For credits (elevenlabs) only the percent rules apply.
- ALL provider-originated strings are sanitized by the CLI before writing (strip control chars, replace `<` `>` with `‹` `›`, cap 200 chars). The QML additionally hard-bounds list sizes (max 8 providers).
- Providers appear in the fixed order: openrouter, vercel-ai, elevenlabs, openai-api, anthropic-api. Disabled providers (config `enabled:false`) are omitted entirely; unconfigured (no key) appear with status `unconfigured`.

## QML data path (the shell never touches the filesystem)

- `service/Service.qml` is the single data owner. It is mounted once per shell (bar widgets and
  panels exist per monitor), so the CLI run and the JSON parse happen once regardless of screen
  count. It runs `/usr/bin/env python3 <CLI> sync` on a 300 s timer, `sync --force` for
  `refresh()`, and `status` (no network) for `reload()`.
- **Single-flight with one queued slot.** A `sync` request arriving during an in-flight `sync` is
  refused *and owed a run of its own* — it may NOT ride the in-flight result, which the CLI
  computed from a config and secrets file it read before the request existed. `startSync` records
  the owed run (`Model.queueSync`; `force` is sticky, so a manual refresh queued behind a timer
  tick still runs forced) and `onExited` starts it (`Model.takeSync`, slot cleared first). There is
  exactly one slot, so any number of refusals collapse into one run and the chain always
  terminates. This is what makes back-to-back key entry work: saving key B while key A's forced
  sync is still fetching must leave both rows configured without waiting for the next tick.
- **Backoff is for runs that produced no data**, not for nonzero exits. Exits 1 (every provider
  errored) and 2 (config/state error) printed a real snapshot and are data outcomes the user
  repairs by editing a file, so the service holds the 300 s cadence and picks the repair up on the
  next tick. Only a run that printed nothing — a missing python3 (127), a crash, an unexpected
  code — increments `failureCount` and pushes the next attempt out (10m/20m/40m, capped at 1 h).
  A successful run resets both. (`Model.syncRunFailed` is the gate.)
- The service parses the process's **stdout** with `Model.parseSnapshot` and publishes
  `snapshotModel`, `parseError`, `refreshError`, `updatedMs` (wall clock of the last accepted
  model) and `busy`. Empty stdout is never a parse error — the exit code carries the reason. Each
  Process owns its own stderr collector, so a reload cannot overwrite a sync's diagnostic tail.
- **`reload()` may only add an error banner, never clear one.** `status` exits 0 whenever it can
  print the snapshot, including while the last `sync`'s failure is still the truth, so its exit
  code must not be mapped onto `refreshError`: opening the popup would erase the banner at the
  moment the user looks at it. A nonzero `status` exit still raises its own banner; only a `sync`
  reports that a run succeeded in producing fresh data.
- `omarchy/Panel.qml` is a view: it binds to the service obtained through
  `bar.shell.serviceFor("io.github.baranskyi.omacash")` (the shell injects a `service` property
  only into `kind:"panel"` plugins, so a bar widget's popup must use that accessor). Refresh
  button / `r` / right-click / IPC `refresh` → `service.refresh()`; opening the popup →
  `service.reload()`; a saved key in KeysView → `service.refresh()`.
- Service absent (still loading, or failed to mount): the panel states this in its status line and
  becomes self-sufficient, running the same CLI itself with the same single-flight, exit-code
  mapping and add-only banner rule — and still reading no file. It must converge on its own, not
  only when the popup is opened: a timer (running **only** while `service === null`, so the
  service's polling is never duplicated) takes a first run shortly after the bar starts and then
  holds the same 300 s cadence. The verb is `sync --force` for a user refresh, a plain `sync`
  while there is still no snapshot to show — `status` alone would only ever re-print the
  pre-first-sync placeholder, which is never published, leaving the pill at `$ …` forever — and
  `status` once a snapshot exists.
- `Model.parseSnapshot` rejects any input over 1 MiB of UTF-8 (`MAX_SNAPSHOT_BYTES`, the same
  bound the CLI applies when reading the file) before `JSON.parse` sees it, and caps the model at
  8 provider rows. A well-formed document with no `generatedAt` and no providers is the
  pre-first-sync placeholder printed by `status`; it is never published (the UI keeps waiting)
  because it would otherwise read as "every provider disabled".

## Leftover agents records  (unlinked by CLI `sync` and `cleanup`)

Versions up to 0.1.0 mirrored every balance into Omarchy's built-in **Agents** panel as
`agents/usage/<provider-id>.json`. That panel is for the coding agents running on the machine,
so this plugin no longer writes there and shows balances in its own panel only.

`sync` and `cleanup` unlink `<provider-id>.json` for the five provider ids and nothing else —
records written by Omarchy's own collectors (`claude.json`, `codex.json`, …) are never touched.
The sweep is janitorial: when `agents/usage` is absent, is a symlink, or is writable by group or
other, it is left alone rather than failing the command. The directory itself is never created
and never removed.

## State directory safety (CLI; enforced on every read, write and delete)

The state directory is a predictable path under a directory other software also writes to, and its
contents are parsed by a long-lived shell. The CLI therefore never trusts a *path* — it trusts an
open file descriptor it validated itself.

- **Trusted root.** `$XDG_STATE_HOME`, else `$HOME`, resolved once. It must be absolute and, once
  opened, must `fstat` as a directory owned by the effective uid with `st_mode & 0o022 == 0`. It is
  the only open in the walk without `O_NOFOLLOW` — a symlinked `$HOME` is the user's own
  configuration — but what it resolves to still has to pass those checks. Created (0700) if absent.
- **Component-by-component walk.** Every component below the root (`.local`, `state`, `omarchy`,
  `<plugin-id>`, `cache`, and — for the record sweep only — `agents`, `usage`) is opened
  relative to its parent's fd with
  `O_RDONLY|O_NOFOLLOW|O_DIRECTORY|O_CLOEXEC`, created with `os.mkdir(name, 0o700, dir_fd=…)` when
  missing, and validated by `fstat` **on the opened fd**: `S_ISDIR`, `st_uid == geteuid()`,
  `st_mode & 0o022 == 0`. Our own dirs (`<plugin-id>`, `cache`) are additionally pinned to 0700 via
  `fchmod` if the mode drifted. The walk returns the open dirfd; every subsequent read, write,
  rename and unlink is dirfd-relative, so a path swapped after the check cannot be raced in.
- **Agents usage dir** (`omarchy/agents/usage`) belongs to Omarchy: the sweep requires the same
  owner and no group/other write, but its mode is left exactly as Omarchy set it (0755 is fine) —
  never forced to 0700, and never created by this plugin.
- **Bounded no-follow reads.** `read_bounded(dirfd, name, limit)` opens with
  `O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK` (the `O_NONBLOCK` keeps a planted FIFO from parking the
  CLI on `open`), then requires `S_ISREG`, `st_uid == geteuid()` and `st_size <= limit`, reads at
  most `limit+1` bytes and refuses a file that grew past the limit, and decodes strict UTF-8.
  Limits: config 256 KiB, secrets 64 KiB, snapshot 1 MiB, each cache file 1 MiB, alerts 256 KiB
  (the snapshot bound matches `Model.MAX_SNAPSHOT_BYTES`). **A missing file returns "absent" and
  callers fall back to defaults; a symlink, a wrong-owner file, a non-regular file, an oversize
  file or non-UTF-8 content is an ERROR and is never silently treated as missing.**
- **Atomic dirfd-relative writes.** Temp created with
  `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC` at 0600 (`fchmod` after, so no umask can widen or
  narrow it), written, `fsync`ed, then `os.replace(tmp, name, src_dir_fd=…, dst_dir_fd=…)` and the
  directory fd `fsync`ed; the temp is unlinked on any failure, so a failed write leaves neither a
  `.tmp-*` file nor a truncated target. `rename` does not follow symlinks, so a symlink planted at
  a write target is replaced, never written through.
- **Deletes** (`sync` clearing disabled/unconfigured providers, `key clear`, `cleanup`) use
  `os.unlink(name, dir_fd=…)` and a dirfd-recursive rmtree, so they remove the link, never the
  target it points at. `cleanup` removes the plugin state dir and any leftover agents record of
  ours; the shared `agents/usage` directory itself is left in place. A delete the kernel refuses (an
  unwritable parent directory, a non-empty directory) is a `StateError` naming that entry — never
  a partial silent success.
- **Concurrency.** `<plugin-id>/lock` (`flock`, 0600, 15 s wait) serializes every read-modify-write
  of a whole state document: `sync`'s fetch-and-write cycle, `key set`/`key clear`/`setup`
  rewriting secrets.json, and `ledger set`/`ledger add` rewriting config.json. The read and the
  write are inside the same lock, so two concurrent saves (two monitors, two KeysView instances)
  cannot drop one another's key or ledger entry. The lock is never held across a prompt — the key
  is read from stdin first — and is never taken twice in one process (`flock` is per open file
  description, so a nested acquire would wait on itself). On contention `sync` waits out the 15 s
  timeout and then prints the existing snapshot; `key`/`ledger` refuse, having written nothing.
- **Degradation.** A failed guarantee raises `StateError` naming the offending path and the reason —
  including a delete or a 0700/0600 mode repair that the filesystem refuses. `sync` and `status`
  turn it into the documented all-providers error snapshot (`error.kind` `"config"`, message
  `"unsafe state path: <path>: <reason>"`), print that snapshot on stdout and exit 2, so the panel
  always gets valid JSON even when the state dir is too broken to write the snapshot to disk.
  `sync` writes that snapshot when it can; **`status` writes nothing** — it prints the snapshot and
  leaves the offending path exactly as it found it, so the file the user has to inspect is still
  there (the verified directory walk may still create or re-mode our own *directories*). Other
  subcommands exit 2 with that message on stderr. No path ever produces a traceback: any residual
  `OSError` is caught at the top level and printed as one `error: state operation failed: <reason>`
  line with exit 2.

## config.json (CLI-owned; hand-editable)

```json
{
  "refreshIntervalSec": 300,
  "thresholds": { "lowPercent": 0.20, "lowUsd": "10", "criticalPercent": 0.05, "criticalUsd": "3" },
  "providers": {
    "openrouter":    { "enabled": true },
    "vercel-ai":     { "enabled": true },
    "elevenlabs":    { "enabled": true, "baseUrl": "https://api.elevenlabs.io" },
    "openai-api":    { "enabled": true, "ledger": { "entries": [ {"date":"2026-08-01","amount":"60.00"} ] } },
    "anthropic-api": { "enabled": true, "amounts_are_cents": true, "ledger": { "entries": [ {"date":"2026-07-15","amount":"50.00"} ] } }
  }
}
```

`funded = Σ ledger.entries.amount`; ledger `since` = earliest entry date (start for cost queries). Missing file → defaults. Malformed, or failing the state-safety checks above → snapshot with every provider `error` kind `config`.

## secrets.json (0600)

Flat `{ "<provider-id>": "<key>" }`. Written only by `key set`/`setup` (stdin/getpass). Env overrides honored for doctor/testing only: `OPENROUTER_KEY`, `VERCEL_AI_GATEWAY_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_ADMIN_KEY`, `ANTHROPIC_ADMIN_KEY`.

In-panel key entry: `omarchy/KeysView.qml` (opened from the popup's "Keys" footer button or by clicking an unconfigured row) is the second writer path for the stdin-only rule. It runs the same `key set <id>` / `key clear <id>` CLI through a Quickshell `Process` whose command array holds only fixed constants (the CLI path plus a provider id from the list above); the key value itself is delivered exclusively via `write(key + "\n")` on the process's stdin (`stdinEnabled: true`, closed right after the write so the CLI's stdin read reaches EOF). The QML clears the input field on submit and drops the held value after the write, so the key never appears in argv, the environment, QML state after send, `shell.json`, or logs. There are therefore exactly two writers of `secrets.json`: `setup`/`key set` in a terminal, and KeysView over `Process` stdin — both stdin-only, and both taking the state lock around the read-modify-write (see "Concurrency"), so one panel's save never drops another's key. Configured/unconfigured state in the Keys view is read from the current snapshot (`status !== "unconfigured"`); no extra CLI status command exists for it. Esc may not abort a save: `Panel.qml` holds the KeysView `Loader` active (hidden) for as long as the view reports a run outstanding (`activeId !== ""`, set before the `Process` starts and cleared only after the result has been applied), so the row state and the follow-up forced sync always happen even if the user closes the view the instant after pressing Save.

## shell.json widget settings (read in QML via setting(name, fallback) — ALWAYS with fallback)

- `pillMode`: "total" (default) | "attention" | "pinned"
- `pinnedProvider`: provider id (default "openrouter")
- `showLabel`: bool, default false (short tag before value, e.g. "OR $23")
- manifest `barWidget.defaults` mirrors these; `schema[]` included as documentation only (no GUI renderer in this build).

## Pill text (Model.js barText)

- total: `~$199` (`~` iff anyEstimated among summed), `$ …` before first snapshot, `$ !` when every provider errored; urgent `active` color when any severity critical (or error), dimmed when everything stale.
- attention: worst provider, `OR $23` style (label always shown in this mode).
- pinned: pinned provider value; wheel on pill cycles pinnedProvider (persisted via updateEntryInline, clock-plugin pattern).
- elevenlabs value renders as `83k cr` (compact credits), money as `$23.40` (2dp, no cents when ≥ $100: `$199`).

## CLI exit codes

`sync`: 0 if at least one provider ok; 1 if every configured provider errored; 2 on config/secrets unreadable **or on any unsafe state path** (see "State directory safety"; a valid error snapshot is still printed on stdout). `status`: 0 printing the snapshot (or the pre-first-sync placeholder), 2 when `snapshot.json` or the state dir chain is unsafe — printing the error snapshot on stdout and writing nothing. `key`/`ledger`/`doctor`/`cleanup`: 2 with a one-line stderr message on an unsafe state path; `key`/`ledger` also 2, nothing written, when the state lock is still held after the 15 s wait. `doctor`: 0 all pass, 1 any fail. Missing python3 surfaces in QML as exit 127 via `/usr/bin/env` → a hint to install python3 that
names no package manager and no privilege escalation.
