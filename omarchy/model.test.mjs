import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./Model.js', import.meta.url), 'utf8');
const model = {};
vm.createContext(model);
vm.runInContext(source, model, {filename: 'Model.js'});

// ---------------------------------------------------------------- manifest

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.strictEqual(manifest.schemaVersion, 1);
assert.strictEqual(typeof manifest.schemaVersion, 'number');
assert.equal(manifest.id, 'io.github.baranskyi.omacash');
assert.deepEqual(manifest.kinds, ['bar-widget', 'service']);
assert.equal(manifest.entryPoints.barWidget, 'omarchy/BarWidget.qml');
assert.equal(manifest.entryPoints.service, 'service/Service.qml');
for (const entry of Object.values(manifest.entryPoints))
  assert.ok(fs.existsSync(new URL('../' + entry, import.meta.url)), entry + ' exists on disk');
assert.equal(manifest.activation, undefined);
assert.equal(manifest.barWidget.aliases, undefined);
assert.equal(manifest.barWidget.defaultSection, 'right');
assert.equal(manifest.barWidget.allowMultiple, false);
assert.deepEqual(manifest.barWidget.defaults, {
  pillMode: 'total',
  pinnedProvider: 'openrouter',
  showLabel: false
});
assert.deepEqual(manifest.barWidget.schema.map(row => row.key),
  ['pillMode', 'pinnedProvider', 'showLabel']);

// ------------------------------------------------------------ QML sources

const barWidgetSource = fs.readFileSync(new URL('./BarWidget.qml', import.meta.url), 'utf8');
assert.match(barWidgetSource, /^BarWidget\s*\{/m);
for (const method of ['open', 'close', 'toggle', 'closeForPopoutSwitch', 'refresh'])
  assert.match(barWidgetSource, new RegExp(`function\\s+${method}\\s*\\(`));
assert.match(barWidgetSource, /source:\s*Qt\.resolvedUrl\("Panel\.qml"\)/);
assert.match(barWidgetSource, /target\.anchorItem\s*=\s*button/);
assert.match(barWidgetSource, /target\.hostWidget\s*=\s*root/);
// Refresh stays local to this instance: right-click and IPC both call
// refresh() directly, never broadcast("refresh") — peer panels converge
// through their own snapshot.json FileView watchers.
assert.match(barWidgetSource, /Qt\.RightButton\)\s*root\.refresh\(\)/);
assert.doesNotMatch(barWidgetSource, /broadcast\("refresh"\)/);
assert.match(barWidgetSource, /Qt\.MiddleButton\)\s*root\.resetPillMode\(\)/);

const panelSource = fs.readFileSync(new URL('./Panel.qml', import.meta.url), 'utf8');
assert.match(panelSource, /^Panel\s*\{/m);
assert.match(panelSource, /manageIpc:\s*false/);
assert.match(panelSource, /property\s+var\s+anchorItem:\s*null/);
assert.match(panelSource, /property\s+var\s+hostWidget:\s*null/);
assert.match(panelSource, /watchChanges:\s*true/);
assert.match(panelSource,
  /command:\s*\["\/usr\/bin\/env",\s*"python3",\s*root\.cliPath,\s*"sync",\s*"--force"\]/);
assert.doesNotMatch(panelSource, /command:\s*\["(?:\/usr\/bin\/)?(?:ba)?sh"/);
assert.match(panelSource, /Model\.settingsWithOverrides\(root\.settings,\s*root\.moduleName,\s*values\)/);
assert.match(panelSource, /bar\.shell\.updateEntryInline\(root\.moduleName,\s*entry\)/);
// No polling timer for data: the only timers are the countdown ticker and
// the missing-file retry; data arrives through the FileView watcher.
assert.doesNotMatch(panelSource, /triggeredOnStart/);
assert.doesNotMatch(panelSource, /broadcast\("refresh"\)/);
// Every applied snapshot re-anchors the clock so the closed-popup tooltip's
// "updated Xm ago" cannot freeze at panel-creation time.
assert.match(panelSource, /function\s+applySnapshot\(content\)\s*\{[^}]*\bnowMs\s*=\s*Date\.now\(\)/);
// The refresh banner goes through the exit-code mapping, not a bare
// launchErrorMessage on any nonzero code.
assert.match(panelSource, /refreshError\s*=\s*Model\.refreshStatusMessage\(exitCode,\s*root\.refreshStderr\)/);

const serviceSource = fs.readFileSync(new URL('../service/Service.qml', import.meta.url), 'utf8');
assert.match(serviceSource,
  /command:\s*\["\/usr\/bin\/env",\s*"python3",\s*root\.cliPath,\s*"sync"\]/);
assert.match(serviceSource, /command:\s*\["mkdir",\s*"-p",\s*root\.stateDir,\s*root\.usageDir\]/);
assert.match(serviceSource, /if\s*\(!prepared\s*\|\|\s*syncProcess\.running\)\s*return/);
assert.match(serviceSource, /Math\.min\(3600000,/);
assert.match(serviceSource, /XDG_STATE_HOME/);
// Secrets never ride in argv or a child environment.
assert.doesNotMatch(serviceSource, /command:[^\n]*(secret|key|token)/i);
assert.doesNotMatch(panelSource, /command:[^\n]*(secret|token)/i);
assert.doesNotMatch(serviceSource, /environment:/);
assert.doesNotMatch(panelSource, /environment:/);

// ---------------------------------------------------------- keys view

assert.ok(fs.existsSync(new URL('./KeysView.qml', import.meta.url)), 'KeysView.qml exists on disk');
const keysViewSource = fs.readFileSync(new URL('./KeysView.qml', import.meta.url), 'utf8');

// SECURITY: the key travels over stdin only. The Process command arrays hold
// fixed constants (cliPath + the activeId property fed from
// Model.keyProviderIds()) and never any TextField binding.
assert.match(keysViewSource,
  /command:\s*\["\/usr\/bin\/env",\s*"python3",\s*root\.cliPath,\s*"key",\s*"set",\s*root\.activeId\]/);
assert.match(keysViewSource,
  /command:\s*\["\/usr\/bin\/env",\s*"python3",\s*root\.cliPath,\s*"key",\s*"clear",\s*root\.activeId\]/);
for (const line of keysViewSource.split('\n'))
  if (/command:/.test(line)) {
    assert.doesNotMatch(line, /\.text\b/, 'no TextField text in a command array');
    assert.doesNotMatch(line, /keyField|pendingKey/, 'no key value in a command array');
  }
assert.doesNotMatch(keysViewSource, /environment:/);
// The key is written to stdin in onStarted, dropped immediately after the
// write, and the channel is closed so `key set` (stdin.read to EOF) returns.
assert.match(keysViewSource, /stdinEnabled:\s*true/);
assert.match(keysViewSource,
  /onStarted:\s*\{\s*write\(root\.pendingKey \+ "\\n"\)\s*root\.pendingKey = ""\s*\/\/[^\n]*\n\s*stdinEnabled = false/);
// The input field is a masked qs.Ui TextField; the field is cleared on submit.
assert.match(keysViewSource, /password:\s*true/);
assert.match(keysViewSource, /field\.text = ""/);
// Single-flight: one busy flag covering both processes gates every button.
assert.match(keysViewSource, /readonly property bool busy: saveProcess\.running \|\| clearProcess\.running/);
// The provider console pages open through the Model URL table only.
assert.match(keysViewSource, /Qt\.openUrlExternally\(card\.meta\.url\)/);
assert.doesNotMatch(keysViewSource, /Qt\.openUrlExternally\("/);
// Errors surface through the sanitized Model helper, not raw stderr.
assert.match(keysViewSource, /Model\.keyCommandErrorMessage\(/);

// Panel wiring: catcher blocked while the keys view is open or a field is
// focused (dev-gallery pattern); unconfigured rows open the keys view; the
// keys view reuses the panel's forced sync; the terminal launcher is gone.
assert.match(panelSource, /blocked:\s*root\.keysOpen\s*\|\|[^\n]*fieldFocused/);
assert.match(panelSource, /onSyncRequested:\s*root\.refresh\(\)/);
assert.match(panelSource, /onCloseRequested:\s*root\.closeKeys\(\)/);
assert.match(panelSource, /onClicked:\s*root\.openKeys\(\)/);
assert.doesNotMatch(panelSource, /openSetup|Set up keys/);

// The exact console URL per provider, asserted against the Model table.
const KEY_URLS = {
  'openrouter': 'https://openrouter.ai/settings/management-keys',
  'vercel-ai': 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys',
  'elevenlabs': 'https://elevenlabs.io/app/developers/api-keys',
  'openai-api': 'https://platform.openai.com/settings/organization/admin-keys',
  'anthropic-api': 'https://platform.claude.com/settings/admin-keys'
};
assert.deepEqual(JSON.parse(JSON.stringify(model.keyProviderIds())), Object.keys(KEY_URLS));
for (const [id, url] of Object.entries(KEY_URLS)) {
  const meta = model.providerKeyMeta(id);
  assert.equal(meta.id, id);
  assert.equal(meta.url, url);
  assert.ok(meta.label.length > 0);
  assert.ok(meta.note.length > 0);
}
assert.equal(model.providerKeyMeta('openai-api').needsLedger, true);
assert.equal(model.providerKeyMeta('anthropic-api').needsLedger, true);
assert.equal(model.providerKeyMeta('openrouter').needsLedger, false);
assert.equal(model.providerKeyMeta('vercel-ai').needsLedger, false);
assert.equal(model.providerKeyMeta('elevenlabs').needsLedger, false);
assert.equal(model.providerKeyMeta('nope'), null);
assert.equal(model.providerKeyMeta(null), null);

// ---------------------------------------------------------- parseSnapshot

const snapshotRaw = JSON.stringify({
  schemaVersion: 1,
  generatedAt: '2026-08-28T15:50:00Z',
  totalRemainingUsd: '118.90',
  anyEstimated: true,
  attention: 'openrouter',
  providers: [
    {id: 'openrouter', name: 'OpenRouter', status: 'ok', source: 'credits',
     balance: {remaining: '23.40', funded: '120.00', spent: '96.60', currency: 'USD', estimated: false},
     percentRemaining: 0.195, severity: 'low', resetsAt: null, ledgerSince: null,
     detail: '$96.60 used of $120.00', fetchedAt: '2026-08-28T15:49:58Z',
     stale: false, error: null, hint: null},
    {id: 'vercel-ai', name: 'Vercel AI Gateway', status: 'ok', source: 'credits',
     balance: {remaining: '95.50', funded: '100.00', spent: '4.50', currency: 'USD', estimated: false},
     percentRemaining: 0.955, severity: 'ok', resetsAt: null, ledgerSince: null,
     detail: '$4.50 used of $100.00', fetchedAt: '2026-08-28T15:49:58Z',
     stale: false, error: null, hint: null},
    {id: 'elevenlabs', name: 'ElevenLabs', status: 'ok', source: 'subscription',
     balance: {remaining: '71000', funded: '100000', spent: '29000', currency: 'credits', estimated: false},
     percentRemaining: 0.71, severity: 'ok', resetsAt: '2026-09-08T00:00:00Z', ledgerSince: null,
     detail: '71,000 of 100,000 credits', fetchedAt: '2026-08-28T15:49:58Z',
     stale: false, error: null, hint: null},
    {id: 'openai-api', name: 'OpenAI API', status: 'ok', source: 'ledger',
     balance: {remaining: '41.22', funded: '60.00', spent: '18.78', currency: 'USD', estimated: true},
     percentRemaining: 0.687, severity: 'ok', resetsAt: null, ledgerSince: '2026-08-01',
     detail: '$18.78 spent since Aug 1', fetchedAt: '2026-08-28T15:10:00Z',
     stale: true, error: null, hint: null},
    {id: 'anthropic-api', name: 'Anthropic API', status: 'unconfigured', source: null,
     balance: null, percentRemaining: null, severity: 'unknown', resetsAt: null, ledgerSince: null,
     detail: '', fetchedAt: '', stale: false, error: null,
     hint: 'Run: omacash key set anthropic-api'}
  ]
});
const NOW = Date.parse('2026-08-28T15:50:00Z');

const parsed = model.parseSnapshot(snapshotRaw);
assert.equal(parsed.ok, true);
const snap = parsed.model;
assert.equal(snap.schemaVersion, 1);
assert.equal(snap.totalRemainingUsd, '118.90');
assert.equal(snap.anyEstimated, true);
assert.equal(snap.attention, 'openrouter');
assert.equal(snap.providers.length, 5);
assert.equal(snap.providers[0].balance.remaining, '23.40');
assert.equal(snap.providers[0].percentRemaining, 0.195);
assert.equal(snap.providers[3].balance.estimated, true);
assert.equal(snap.providers[3].stale, true);
assert.equal(snap.providers[4].status, 'unconfigured');
assert.equal(snap.providers[4].balance, null);
assert.equal(snap.providers[4].hint, 'Run: omacash key set anthropic-api');

// Malformed input is rejected, never partially trusted.
assert.equal(model.parseSnapshot('{').ok, false);
assert.equal(model.parseSnapshot('null').ok, false);
assert.equal(model.parseSnapshot('{}').ok, false);
assert.equal(model.parseSnapshot(JSON.stringify({schemaVersion: '1', providers: []})).ok, false);
assert.equal(model.parseSnapshot(JSON.stringify({schemaVersion: 2, providers: []})).ok, false);
assert.equal(model.parseSnapshot(JSON.stringify({schemaVersion: 1})).ok, false);
assert.equal(model.parseSnapshot(JSON.stringify({schemaVersion: 1, providers: [{name: 'no id'}]})).ok, false);
assert.equal(model.parseSnapshot(JSON.stringify({schemaVersion: 1, providers: []})).ok, true);

// Hard bounds: never more than 8 provider rows reach QML.
const crowd = {schemaVersion: 1, generatedAt: '', totalRemainingUsd: '0.00', anyEstimated: false,
  attention: null, providers: []};
for (let i = 0; i < 12; i++)
  crowd.providers.push({id: 'p' + i, name: 'P' + i, status: 'ok', source: 'credits',
    balance: {remaining: '1.00', currency: 'USD', estimated: false},
    percentRemaining: 0.5, severity: 'ok', stale: false, error: null});
assert.equal(model.parseSnapshot(JSON.stringify(crowd)).model.providers.length, 8);

// Sanitizing survives the second pass even on hand-edited snapshots.
const dirty = model.parseSnapshot(JSON.stringify({schemaVersion: 1, providers: [
  {id: 'openrouter', name: 'Open\u0000Router<b>', status: 'ok', source: 'credits',
   balance: {remaining: '5.00', currency: 'USD', estimated: false},
   percentRemaining: 7, severity: 'weird', stale: false,
   error: null, detail: 'a\u202eb'}
]})).model.providers[0];
assert.equal(dirty.name, 'OpenRouter<b>');
assert.equal(model.providerRow(dirty, NOW).name, 'OpenRouter‹b›');
assert.equal(dirty.percentRemaining, 1);
assert.equal(dirty.severity, 'unknown');
assert.equal(dirty.detail, 'ab');
assert.equal(model.cleanText('bad\u0000value', 20), 'badvalue');
assert.equal(model.autoTextSafe('<img src="https://example.test/pixel">'),
  '‹img src="https://example.test/pixel"›');

// Invalid decimal strings are dropped rather than rendered as $NaN.
const badMoney = model.parseSnapshot(JSON.stringify({schemaVersion: 1, providers: [
  {id: 'openrouter', status: 'ok', source: 'credits',
   balance: {remaining: '12,50', currency: 'USD'}, severity: 'ok', stale: false, error: null}
]})).model.providers[0];
assert.equal(badMoney.balance, null);

// ------------------------------------------------------------- formatters

assert.equal(model.formatMoney('23.40'), '$23.40');
assert.equal(model.formatMoney('96.6'), '$96.60');
assert.equal(model.formatMoney('9.5'), '$9.50');
assert.equal(model.formatMoney('0.00'), '$0.00');
assert.equal(model.formatMoney('100.00'), '$100');
assert.equal(model.formatMoney('199.99'), '$199');
assert.equal(model.formatMoney('1234'), '$1234');
assert.equal(model.formatMoney('-3.00'), '-$3.00');
assert.equal(model.formatMoney('abc'), '');
assert.equal(model.formatMoney(''), '');

assert.equal(model.formatCredits('71000'), '71k cr');
assert.equal(model.formatCredits('83000'), '83k cr');
assert.equal(model.formatCredits('71500'), '71.5k cr');
assert.equal(model.formatCredits('250000'), '250k cr');
assert.equal(model.formatCredits('999'), '999 cr');
assert.equal(model.formatCredits('1500000'), '1.5M cr');
assert.equal(model.formatCredits('12.5'), '');

const HOUR = 3600000, DAY = 24 * HOUR, MINUTE = 60000;
assert.equal(model.formatReset(new Date(NOW + DAY + HOUR + MINUTE).toISOString(), NOW), 'Resets in 1d 1h');
assert.equal(model.formatReset(new Date(NOW + 2 * HOUR + 5 * MINUTE).toISOString(), NOW), 'Resets in 2h 5m');
assert.equal(model.formatReset(new Date(NOW - 1000).toISOString(), NOW), 'Reset due');
assert.equal(model.formatReset('not-a-date', NOW), '');
assert.equal(model.formatReset('', NOW), '');
assert.equal(model.formatUpdated('2026-08-28T15:47:00Z', NOW), 'updated 3m ago');
assert.equal(model.formatUpdated('2026-08-28T15:49:30Z', NOW), 'updated just now');
assert.equal(model.formatUpdated('junk', NOW), '');

assert.equal(model.severityRole('ok'), 'accent');
assert.equal(model.severityRole('low'), 'warning');
assert.equal(model.severityRole('critical'), 'urgent');
assert.equal(model.severityRole('unknown'), 'dim');

// ------------------------------------------------------------------ pill

// Before the first snapshot.
assert.equal(model.barText(null, 'total', 'openrouter', false, false), '$ …');
assert.equal(model.barText(null, 'attention', 'openrouter', false, false), '$ …');
assert.equal(model.barText(null, 'total', 'openrouter', false, true), '$');

// First run: a snapshot exists but no provider is configured yet — keep the
// pre-snapshot placeholder in every mode instead of an alarming "$0.00".
const firstRun = model.parseSnapshot(JSON.stringify({
  schemaVersion: 1, generatedAt: '2026-08-28T15:50:00Z', totalRemainingUsd: '0.00',
  anyEstimated: false, attention: null, providers: [
    {id: 'openrouter', name: 'OpenRouter', status: 'unconfigured', severity: 'unknown',
     stale: false, balance: null, percentRemaining: null, error: null,
     hint: 'Run: omacash key set openrouter'},
    {id: 'anthropic-api', name: 'Anthropic API', status: 'unconfigured', severity: 'unknown',
     stale: false, balance: null, percentRemaining: null, error: null,
     hint: 'Run: omacash key set anthropic-api'}
  ]})).model;
assert.equal(model.totalText(firstRun), '$ …');
assert.equal(model.barText(firstRun, 'total', 'openrouter', false, false), '$ …');
assert.equal(model.barText(firstRun, 'attention', 'openrouter', false, false), '$ …');
assert.equal(model.barText(firstRun, 'pinned', 'openrouter', true, false), '$ …');
assert.equal(model.barText(firstRun, 'total', 'openrouter', false, true), '$');
// All providers disabled (empty list) reads the same way.
const noneEnabled = model.parseSnapshot(JSON.stringify(
  {schemaVersion: 1, totalRemainingUsd: '0.00', anyEstimated: false, providers: []})).model;
assert.equal(model.totalText(noneEnabled), '$ …');
assert.equal(model.barText(noneEnabled, 'total', 'openrouter', false, false), '$ …');

// total: ~ iff anyEstimated among the summed values.
assert.equal(model.barText(snap, 'total', 'openrouter', false, false), '~$118');
const plainTotal = model.parseSnapshot(snapshotRaw);
plainTotal.model.anyEstimated = false;
assert.equal(model.barText(plainTotal.model, 'total', 'openrouter', false, false), '$118');
assert.equal(model.totalText(snap), '~$118');

// attention: worst provider, tag always shown.
assert.equal(model.barText(snap, 'attention', 'elevenlabs', false, false), 'OR $23.40');
const noAttention = model.parseSnapshot(snapshotRaw).model;
noAttention.attention = '';
// Fallback picks the lowest percentRemaining among ready providers.
assert.equal(model.barText(noAttention, 'attention', '', false, false), 'OR $23.40');

// pinned: value only, tag with showLabel; wheel cycling is a separate helper.
assert.equal(model.barText(snap, 'pinned', 'vercel-ai', false, false), '$95.50');
assert.equal(model.barText(snap, 'pinned', 'vercel-ai', true, false), 'VA $95.50');
assert.equal(model.barText(snap, 'pinned', 'elevenlabs', false, false), '71k cr');
assert.equal(model.barText(snap, 'pinned', 'elevenlabs', true, false), 'EL 71k cr');
assert.equal(model.barText(snap, 'pinned', 'openai-api', false, false), '~$41.22');
assert.equal(model.barText(snap, 'pinned', 'anthropic-api', false, false), '—');
assert.equal(model.barText(snap, 'pinned', 'anthropic-api', true, false), 'AN —');
// A pinned id missing from the snapshot falls back to the total.
assert.equal(model.barText(snap, 'pinned', 'nope', false, false), '~$118');

// Every configured provider errored.
const allErrored = model.parseSnapshot(JSON.stringify({
  schemaVersion: 1, generatedAt: '2026-08-28T15:50:00Z', totalRemainingUsd: '0.00',
  anyEstimated: false, attention: 'openrouter', providers: [
    {id: 'openrouter', name: 'OpenRouter', status: 'error', severity: 'unknown', stale: false,
     balance: null, percentRemaining: null,
     error: {kind: 'auth', message: 'HTTP 401', hint: 'Check the management key'}},
    {id: 'elevenlabs', name: 'ElevenLabs', status: 'error', severity: 'unknown', stale: false,
     balance: null, percentRemaining: null, error: {kind: 'network', message: 'timeout'}},
    {id: 'anthropic-api', name: 'Anthropic API', status: 'unconfigured', severity: 'unknown',
     stale: false, balance: null, percentRemaining: null, hint: 'Run: omacash setup'}
  ]})).model;
assert.equal(model.everyConfiguredErrored(allErrored), true);
assert.equal(model.barText(allErrored, 'total', 'openrouter', false, false), '$ !');
assert.equal(model.barText(allErrored, 'attention', 'openrouter', false, false), '$ !');
assert.equal(model.barText(allErrored, 'pinned', 'openrouter', false, false), '$ !');
assert.equal(model.barText(allErrored, 'total', 'openrouter', false, true), '!');
assert.equal(model.alarming(allErrored), true);
assert.equal(model.everyConfiguredErrored(snap), false);

// One error among healthy providers alarms without taking over the pill.
const oneError = model.parseSnapshot(snapshotRaw).model;
oneError.providers[1].status = 'error';
assert.equal(model.alarming(oneError), true);
// A failed provider still holding last-good data keeps showing its value;
// "!" is reserved for an error with nothing left to show.
assert.equal(model.barText(oneError, 'pinned', 'vercel-ai', true, false), 'VA $95.50');
oneError.providers[1].balance = null;
assert.equal(model.barText(oneError, 'pinned', 'vercel-ai', true, false), 'VA !');
assert.equal(model.alarming(snap), false);
const critical = model.parseSnapshot(snapshotRaw).model;
critical.providers[0].severity = 'critical';
assert.equal(model.alarming(critical), true);

// Dim the pill only when everything shown is cached.
assert.equal(model.allStale(snap), false);
const staleAll = model.parseSnapshot(snapshotRaw).model;
for (const p of staleAll.providers) p.stale = true;
assert.equal(model.allStale(staleAll), true);
assert.equal(model.allStale(null), false);

assert.equal(model.anyUnconfigured(snap), true);
assert.equal(model.anyUnconfigured(crowd.providers.length ? model.parseSnapshot(JSON.stringify(crowd)).model : null), false);

// -------------------------------------------------------- tooltip + hero

const tooltip = model.tooltipText(snap, NOW);
assert.match(tooltip, /^Omacash ~\$118 /);
assert.match(tooltip, /OR ~?\$23\.40/);
assert.match(tooltip, /EL 71k cr/);
assert.match(tooltip, /updated just now/);
assert.doesNotMatch(tooltip, /AN/); // unconfigured rows stay out of the tooltip
assert.equal(model.tooltipText(null, NOW), 'Omacash · waiting for first sync');

assert.equal(model.subtitle(snap, NOW),
  '1 estimated · 1 stale · 1 not configured · updated just now');
assert.equal(model.subtitle(null, NOW), 'Waiting for first sync');
assert.match(model.subtitle(allErrored, NOW), /2 errors · 1 not configured/);

// ------------------------------------------------------------------ rows

// Unconfigured providers are hidden from the list once anything is
// configured (still reachable via the Keys view); on a first run with
// nothing configured the full list doubles as the onboarding checklist.
const rows = model.providerRows(snap, NOW);
assert.equal(rows.length, 4);
assert.deepEqual(Array.from(rows, r => r.id),
  ['openrouter', 'vercel-ai', 'elevenlabs', 'openai-api']);
assert.equal(model.providerRows(firstRun, NOW).length, 2);
assert.ok(model.providerRows(firstRun, NOW).every(r => r.greyed));

assert.equal(rows[0].name, 'OpenRouter');
assert.equal(rows[0].tier, 'Prepaid');
assert.equal(rows[0].value, '$23.40');
assert.equal(rows[0].percent, 0.195);
assert.equal(rows[0].meterRole, 'warning');
assert.equal(rows[0].sub, '$96.60 used of $120.00');
assert.equal(rows[0].note, '');
assert.equal(rows[0].greyed, false);

assert.equal(rows[2].tier, 'Subscription');
assert.equal(rows[2].value, '71k cr');
assert.match(rows[2].sub, /71,000 of 100,000 credits · Resets in \d+d \d+h/);

assert.equal(rows[3].tier, 'Prepaid (est.)');
assert.equal(rows[3].value, '~$41.22');
assert.match(rows[3].note, /^Cached data · updated \d+m ago$/);
assert.equal(rows[3].noteRole, 'warning');

const unconfRow = model.providerRow(snap.providers[4], NOW);
assert.equal(unconfRow.greyed, true);
assert.equal(unconfRow.value, '—');
assert.equal(unconfRow.percent, -1);
assert.equal(unconfRow.note, 'Run: omacash key set anthropic-api');
assert.equal(unconfRow.noteRole, 'dim');

const errorRow = model.providerRow(allErrored.providers[0], NOW);
assert.equal(errorRow.value, '!');
assert.equal(errorRow.note, 'HTTP 401 · Check the management key');
assert.equal(errorRow.noteRole, 'urgent');
assert.equal(errorRow.percent, -1);

const critRow = model.providerRow(critical.providers[0], NOW);
assert.equal(critRow.valueRole, 'urgent');
assert.equal(critRow.meterRole, 'urgent');

assert.equal(model.providerRows(null, NOW).length, 0);

// --------------------------------------------------------------- settings

assert.equal(model.cyclePinned(snap, 'openrouter', 1), 'vercel-ai');
assert.equal(model.cyclePinned(snap, 'anthropic-api', 1), 'openrouter');
assert.equal(model.cyclePinned(snap, 'openrouter', -1), 'anthropic-api');
assert.equal(model.cyclePinned(snap, 'unknown', 1), 'vercel-ai');
assert.equal(model.cyclePinned(null, 'openrouter', 1), 'vercel-ai');
assert.equal(model.cyclePinned(null, 'anthropic-api', 1), 'openrouter');

assert.equal(model.pillModeSetting('attention'), 'attention');
assert.equal(model.pillModeSetting('pinned'), 'pinned');
assert.equal(model.pillModeSetting('bogus'), 'total');
assert.equal(model.pillModeSetting(undefined), 'total');
assert.equal(model.booleanSetting('true', false), true);
assert.equal(model.booleanSetting('0', true), false);
assert.equal(model.booleanSetting(undefined, true), true);

const prior = {pillMode: 'pinned', future: {keep: true}, id: 'stale-id'};
const next = model.settingsWithOverrides(prior, 'io.github.baranskyi.omacash', {pinnedProvider: 'elevenlabs'});
assert.deepEqual(JSON.parse(JSON.stringify(next)), {
  id: 'io.github.baranskyi.omacash',
  pillMode: 'pinned',
  future: {keep: true},
  pinnedProvider: 'elevenlabs'
});
assert.equal(prior.pinnedProvider, undefined);
const guarded = model.settingsWithOverrides({}, 'io.github.baranskyi.omacash',
  {id: 'wrong', constructor: 'x', prototype: 'x', showLabel: true});
assert.equal(guarded.id, 'io.github.baranskyi.omacash');
assert.notEqual(guarded.constructor, 'x');
assert.equal(guarded.prototype, undefined);
assert.equal(guarded.showLabel, true);

assert.match(model.launchErrorMessage(127, ''), /python3 was not found/);
assert.match(model.launchErrorMessage(127, ''), /pacman -S python/);
assert.equal(model.launchErrorMessage(3, 'traceback text'), 'traceback text');
assert.equal(model.launchErrorMessage(3, ''), 'The sync command failed without an error message.');

// Refresh banner mapping: 1 and 2 are data outcomes carried by the snapshot
// rows — no generic banner for 1, a short pointer for 2. launchErrorMessage
// is reserved for 127 and unexpected codes.
assert.equal(model.refreshStatusMessage(0, ''), '');
assert.equal(model.refreshStatusMessage(1, 'every provider errored'), '');
assert.equal(model.refreshStatusMessage(2, 'config unreadable'), 'Configuration error — see provider rows.');
assert.match(model.refreshStatusMessage(127, ''), /python3 was not found/);
assert.equal(model.refreshStatusMessage(3, 'traceback text'), 'traceback text');
assert.equal(model.refreshStatusMessage(3, ''), 'The sync command failed without an error message.');

// ----------------------------------------------------- key entry helpers

// Configured state is derived from the current snapshot only.
assert.equal(model.providerConfigured(snap, 'openrouter'), true);
assert.equal(model.providerConfigured(snap, 'openai-api'), true);
assert.equal(model.providerConfigured(snap, 'anthropic-api'), false);
assert.equal(model.providerConfigured(null, 'openrouter'), false);
assert.equal(model.providerConfigured(snap, 'nope'), false);
// An errored provider still counts as configured (it has a key).
assert.equal(model.providerConfigured(allErrored, 'openrouter'), true);

assert.equal(model.ledgerHint('/abs/cli', 'openai-api'),
  'Also needs a funded ledger: python3 /abs/cli ledger set openai-api --funded N --since YYYY-MM-DD');

assert.equal(model.keyCommandErrorMessage(0, 'noise'), '');
assert.match(model.keyCommandErrorMessage(127, ''), /python3 was not found/);
assert.equal(model.keyCommandErrorMessage(1, 'error: empty key\n'), 'error: empty key');
assert.equal(model.keyCommandErrorMessage(1, ''), 'The key command failed (exit 1).');
// Stderr tail only, sanitized (controls stripped, angle brackets replaced).
assert.equal(model.keyCommandErrorMessage(1, 'line1\nline2\n<script>' + String.fromCharCode(0) + 'boom'),
  'line2 \u00b7 \u2039script\u203aboom');
// Capped: a huge traceback cannot flood the row.
assert.ok(model.keyCommandErrorMessage(1, 'x'.repeat(5000)).length <= 301);

console.log('Omacash model tests passed');
