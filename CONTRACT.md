# Data contracts — single source of truth

Both the Python CLI and the QML/JS frontend MUST conform to this file exactly.
If something here conflicts with any other document, THIS file wins.

## Identifiers

- Plugin id: `io.github.baranskyi.balances`
- CLI file: `bin/omarchy-balances` (invoked as `/usr/bin/env python3 <pluginDir>/bin/omarchy-balances …`)
- Provider ids (fixed, used everywhere — config, cache, snapshot, agents records):
  `openrouter`, `vercel-ai`, `elevenlabs`, `openai-api`, `anthropic-api`
- State dir: `~/.local/state/omarchy/io.github.baranskyi.balances/`
  (`secrets.json` 0600 in 0700 dir, `config.json`, `cache/<id>.json`, `snapshot.json`, `alerts.json`, `lock`)
- Agents records dir: `~/.local/state/omarchy/agents/usage/<provider-id>.json`
- Respect `XDG_STATE_HOME` (fallback `~/.local/state`) in BOTH the CLI and QML.

## snapshot.json  (written atomically by CLI `sync`; printed by `sync`/`status`; read by Panel.qml FileView)

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
- `error` is null or `{ "kind": "auth|network|http|config|unit-suspect|stale-expired", "message": "...", "hint": "..." }`. `hint` (top-level) is only for `unconfigured` rows. Hints/authHelpText spell out the full invocation, `"python3 " + abspath(CLI)` (e.g. "Run: python3 <pluginDir>/bin/omarchy-balances key set openrouter"), since bare `omarchy-balances` is not on PATH.
- `stale:true` = showing last-good data after a failed refresh; kept ≤ 7 days, then `balance:null` + error kind `stale-expired`.
- `estimated:true` on ledger-derived balances (openai-api, anthropic-api) and on any value the CLI computed rather than read.
- `totalRemainingUsd`: sum of USD `remaining` over ready providers only (credits excluded); decimal string; `"0.00"` if none. `anyEstimated`: any summed entry estimated.
- `attention`: provider id with the worst severity (critical > low), ties broken by lowest percentRemaining; null when all ok/unknown.
- Severity thresholds (config-overridable): low if percentRemaining < 0.20 OR remaining < $10; critical if < 0.05 OR < $3. For credits (elevenlabs) only the percent rules apply.
- ALL provider-originated strings are sanitized by the CLI before writing (strip control chars, replace `<` `>` with `‹` `›`, cap 200 chars). The QML additionally hard-bounds list sizes (max 8 providers).
- Providers appear in the fixed order: openrouter, vercel-ai, elevenlabs, openai-api, anthropic-api. Disabled providers (config `enabled:false`) are omitted entirely; unconfigured (no key) appear with status `unconfigured`.

## Agents panel records  (written atomically by CLI `sync` to agents/usage/<id>.json)

Money in **agents records** is **JSON numbers** (the panel computes `remaining / funded`).
Only written for configured providers; `sync` unlinks the record (and cache file) of disabled and
unconfigured providers. On fetch error:

- error kind NOT `auth`/`config`, and a last-good fetch ≤ 7 days old exists → keep writing the
  cached last-good record **unchanged** (`updatedAt` stays at the data's fetch time);
- error kind `auth` or `config`, OR last-good older than 7 days (`stale-expired`), OR no last-good →
  write `ready:false` + `authHelpText` (the error hint), with no balance/limits fields.

Common fields: `schemaVersion:1`, `id` == filename stem (assert before write), `name`,
`updatedAt` (ISO8601), `ready` (bool), `scope:"account"`, `tierLabel`, `usageStatusText`,
`authHelpText` (only when not ready), plus zeroed count fields the panel tolerates missing —
include `limits: []` when unused.

| id | balance{} (numbers) | limits[] | tierLabel | usageStatusText example |
|---|---|---|---|---|
| openrouter | remaining/funded/spent, currency:"USD", estimated:false | [] | "Prepaid" (or "Key limit" on fallback) | "$23.40 remaining · $96.60 used" |
| vercel-ai | same | [] | "AI Gateway" | "$95.50 remaining" |
| elevenlabs | — omit balance (not money) | [{label:"Credits", percent: used/limit (0..1), resetsAt: ISO8601, title:"Credits"}] | subscription tier | "71,000 of 100,000 credits" |
| openai-api | remaining/funded/spent, "USD", **estimated:true** | [] | "Prepaid (est.)" | "≈ $41.22 remaining since Aug 1" |
| anthropic-api | same | [] | "Prepaid (est.)" | "≈ $…" |

Panel facts (verified in /usr/share/omarchy/shell/plugins/agents/): tab shows if balance set OR limits nonempty; alarm when remaining/funded ≤ 0.1; "$" prefix for USD; `estimated` appends "· estimated" to the detail line.

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

`funded = Σ ledger.entries.amount`; ledger `since` = earliest entry date (start for cost queries). Missing file → defaults. Malformed → snapshot with every provider `error` kind `config`.

## secrets.json (0600)

Flat `{ "<provider-id>": "<key>" }`. Written only by `key set`/`setup` (stdin/getpass). Env overrides honored for doctor/testing only: `OPENROUTER_KEY`, `VERCEL_AI_GATEWAY_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_ADMIN_KEY`, `ANTHROPIC_ADMIN_KEY`.

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

`sync`: 0 if at least one provider ok; 1 if every configured provider errored; 2 on config/secrets unreadable. `doctor`: 0 all pass, 1 any fail. Missing python3 surfaces in QML as exit 127 via `/usr/bin/env` → install hint.
