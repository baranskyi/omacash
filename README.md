# Balances — money left on your AI services, in the Omarchy bar

One pill in the Omarchy Quattro bar showing what is **left** — not what you spent — across
five services, with a keyboard-navigable popup and native records in Omarchy's built-in
Agents panel (so balances ride its cross-machine sync).

| Service | What you see | How |
|---|---|---|
| OpenRouter | remaining $ | official credits API (Management key), or per-key limit with a regular key |
| Vercel AI Gateway | remaining $ | official credits API |
| ElevenLabs | remaining credits + reset date | subscription API (key needs only the User: Read scope) |
| OpenAI API | ≈ remaining $ *(estimated)* | your top-ups (a local ledger you maintain) minus the official Costs API spend |
| Anthropic API | ≈ remaining $ *(estimated)* | same ledger approach over the official cost report |

OpenAI and Anthropic expose **no balance endpoint at all**, so their rows are estimates:
you record top-ups with `ledger add`, the plugin subtracts real API-reported spend and marks
the result `≈`. Everything else is read straight from the provider.

## Requirements

- Omarchy with the Quattro shell (the plugin system).
- `python3` (any recent version; part of every Omarchy install). Stdlib only — no pip packages.
- Optional: `libnotify` (`notify-send`) for low-balance notifications; part of Omarchy's defaults.

No other external dependencies. The plugin talks only to the five provider APIs listed above.

## Install

```bash
omarchy plugin add https://github.com/baranskyi/omarchy-balances.git --enable
```

Pick a bar section when prompted (default: right). The pill shows `$ …` until keys are configured.

### Configure keys

**Primary path — in the panel.** Click the pill, press **Keys** (or click any
"not configured" provider row). Each provider block shows whether a key is stored, says
which key type that provider needs, links straight to the console page that issues it
("Open key page ↗"), and takes a paste into a masked field. Save sends the key to the CLI
over stdin and re-syncs immediately, so the row flips to "Configured ✓" and the pill
updates. Keys you need:

- **OpenRouter** — a [Management key](https://openrouter.ai/settings/management-keys) for the account balance. A regular inference key also works, but then the plugin can only show that key's own spend limit remainder.
- **Vercel AI Gateway** — an [AI Gateway API key](https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys) (the deep link resolves your team). Deliberately *not* a Vercel account token.
- **ElevenLabs** — an [API key](https://elevenlabs.io/app/developers/api-keys) with only the **User: Read** scope. Such a key cannot generate audio or spend credits.
- **OpenAI API** — an [Admin key](https://platform.openai.com/settings/organization/admin-keys) (`sk-admin-…`), required by OpenAI's Costs API.
- **Anthropic API** — an [Admin key](https://platform.claude.com/settings/admin-keys) (`sk-ant-admin…`) from the Claude Console, required by Anthropic's cost report. Needs a Console organization.

**Terminal alternative** (same storage, guided and live-tested):

```bash
BAL="python3 $HOME/.config/omarchy/plugins/io.github.baranskyi.balances/bin/omarchy-balances"
$BAL setup          # guided: paste each key (hidden input), live-tested immediately
```

Or per provider: `$BAL key set openrouter` etc.

For OpenAI/Anthropic also record what you have funded (the panel's Keys view reminds you
of the exact command):

```bash
$BAL ledger set openai-api --funded 60 --since 2026-08-01
$BAL ledger add openai-api --amount 20      # after every top-up
```

Then `$BAL doctor` runs one live check per provider (and asks you to confirm Anthropic's
currency unit against the Console once), and `$BAL sync --force` fills the bar.

### Key security

Keys are read from stdin only — hidden input in the terminal, a `Process` stdin write from
the panel's Keys view — stored in
`~/.local/state/omarchy/io.github.baranskyi.balances/secrets.json` (mode 600), sent only as
HTTP headers to the provider's own API host, and never appear in process arguments,
`shell.json`, agents records, or logs. The Keys view clears its input field the moment you
press Save. The OpenAI/Anthropic admin keys and the OpenRouter
management key are powerful credentials — this plugin only reads with them, but treat the
machine's disk as their security boundary.

## Use

- **Left-click** the pill — popup with all balances (j/k scroll, r refresh, Esc close). The **Keys** footer button opens in-panel key entry; Esc there first returns to the balances list.
- **Right-click** — refresh now. **Wheel** — cycle the pinned provider (in `pinned` mode).
- The same balances appear as tabs in Omarchy's built-in **Agents** panel; enable its
  `syncMode` to carry them to your other machines.
- Low/critical balances recolor the pill and send one desktop notification (no repeats).

Settings (display only) live in `shell.json`:

```bash
omarchy bar set io.github.baranskyi.balances pillMode attention   # total | attention | pinned
omarchy bar set io.github.baranskyi.balances showLabel true --json
```

Behavior settings (refresh interval, thresholds, ledgers, per-provider enable) live in
`~/.local/state/omarchy/io.github.baranskyi.balances/config.json` — see
[`config.example.json`](config.example.json).

## Remove

```bash
python3 ~/.config/omarchy/plugins/io.github.baranskyi.balances/bin/omarchy-balances cleanup
omarchy plugin remove io.github.baranskyi.balances
```

`cleanup` deletes the plugin's five Agents-panel records and its state directory
(including stored keys). Run it first — the Agents panel keeps records forever otherwise.

## Development

```bash
node omarchy/model.test.mjs                      # pure-JS model tests
./bin/omarchy-balances selftest                  # offline CLI tests against tests/fixtures/
omarchy plugin validate .
omarchy plugin add ~/path/to/omarchy-balances    # symlinks fail validation; add the dir itself
```

## License

MIT — see [LICENSE](LICENSE). The bar-widget QML skeleton and model-test harness are adapted
from [akitaonrails/ai-usagebar](https://github.com/akitaonrails/ai-usagebar) (MIT,
© 2026 AkitaOnRails); attribution is retained in the license file.
