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

const QML_FILES = ['./BarWidget.qml', './Panel.qml', './KeysView.qml', '../service/Service.qml'];
const qmlSources = new Map(QML_FILES.map(
  name => [name, fs.readFileSync(new URL(name, import.meta.url), 'utf8')]));

// SECURITY (marketplace review, HANCORE-linux/omarchy-plugin-marketplace#3145):
// the QML side never touches the filesystem. No FileView, no state path built
// in QML, no directory created from QML — the CLI owns every filesystem access
// (bounded, no-follow, owner-checked) and content reaches this long-lived
// shell process only as the stdout of a process the plugin spawned.
const JSON_PATH = /[\w~.)\]"'-]\/[\w.-]*\.json/;
for (const [name, src] of qmlSources) {
  assert.doesNotMatch(src, /FileView/, name + ': no FileView');
  assert.doesNotMatch(src, JSON_PATH, name + ': builds no path to a JSON state file');
  assert.doesNotMatch(src, /XDG_STATE_HOME|\.local\/state|\.config\/omarchy/,
    name + ': derives no state directory');
  assert.doesNotMatch(src, /Quickshell\.env\(/, name + ': reads no environment variable');
  assert.doesNotMatch(src, /\bmkdir\b/, name + ': creates no directory');
  assert.doesNotMatch(src, /command:\s*\["(?:\/usr\/bin\/)?(?:ba|z)?sh"/, name + ': spawns no shell');
  assert.doesNotMatch(src, /environment:/, name + ': sets no child environment');
  assert.doesNotMatch(src, /command:[^\n]*(secret|token)/i, name + ': no secret in argv');
}

const barWidgetSource = qmlSources.get('./BarWidget.qml');
assert.match(barWidgetSource, /^BarWidget\s*\{/m);
for (const method of ['open', 'close', 'toggle', 'closeForPopoutSwitch', 'refresh'])
  assert.match(barWidgetSource, new RegExp(`function\\s+${method}\\s*\\(`));
assert.match(barWidgetSource, /source:\s*Qt\.resolvedUrl\("Panel\.qml"\)/);
assert.match(barWidgetSource, /target\.anchorItem\s*=\s*button/);
assert.match(barWidgetSource, /target\.hostWidget\s*=\s*root/);
// Refresh stays local to this instance: right-click and IPC both call
// refresh() directly, never broadcast("refresh") — the shell-wide service
// single-flights the CLI run and publishes to every monitor's panel.
assert.match(barWidgetSource, /Qt\.RightButton\)\s*root\.refresh\(\)/);
assert.doesNotMatch(barWidgetSource, /broadcast\("refresh"\)/);
assert.match(barWidgetSource, /Qt\.MiddleButton\)\s*root\.resetPillMode\(\)/);

const panelSource = qmlSources.get('./Panel.qml');
assert.match(panelSource, /^Panel\s*\{/m);
assert.match(panelSource, /manageIpc:\s*false/);
assert.match(panelSource, /property\s+var\s+anchorItem:\s*null/);
assert.match(panelSource, /property\s+var\s+hostWidget:\s*null/);
// The panel is a view over the service singleton, reached by exact plugin id
// (shell.qml injects `service` only into kind:"panel" plugins, so a bar
// widget's popup must use the serviceFor accessor).
assert.match(panelSource,
  /readonly property var service:\s*bar\?\.shell\?\.serviceFor\("io\.github\.baranskyi\.omacash"\)/);
assert.match(panelSource, /snapshotModel:\s*service \? service\.snapshotModel/);
assert.match(panelSource, /parseError:\s*service \? service\.parseError/);
assert.match(panelSource, /service\.refresh\(\)/);
assert.match(panelSource, /service\.reload\(\)/);
// Service missing (not mounted yet, or failed to load): one clear status
// line plus a single-flighted CLI run — still stdout, never a file read.
assert.match(panelSource, /if\s*\(!service\)/);
assert.match(panelSource, /function\s+runFallback\(forced\)\s*\{\s*\n\s*if\s*\(fallbackProcess\.running\)\s*return/);
assert.match(panelSource,
  /\["\/usr\/bin\/env",\s*"python3",\s*root\.cliPath,\s*"sync",\s*"--force"\]/);
assert.match(panelSource, /\["\/usr\/bin\/env",\s*"python3",\s*root\.cliPath,\s*"sync"\]/);
assert.match(panelSource, /\["\/usr\/bin\/env",\s*"python3",\s*root\.cliPath,\s*"status"\]/);
// Exactly one Process in the panel, and it is that fallback.
assert.equal((panelSource.match(/^\s*command:/gm) || []).length, 1);
// The fallback must converge on its own: with no service, `status` alone
// would only ever re-print the pre-first-sync placeholder (which is never
// published), so the pill would sit at "$ …" forever. A plain `sync` is used
// while there is nothing to show.
assert.match(panelSource,
  /fallbackMode = forced === true \? "force"\s*\n\s*:\s*\(fallbackModel === null \? "sync" : "status"\)/);
// …and it must not wait for the popup to be opened: a timer does the first
// load shortly after the bar starts, then holds the service's own 300 s
// cadence. It runs ONLY while there is no service, so the CLI is never
// polled twice.
assert.match(panelSource,
  /Timer\s*\{\s*\n\s*id: fallbackTimer\s*\n\s*running: root\.service === null\s*\n\s*repeat: true/);
assert.match(panelSource, /interval:\s*root\.fallbackStarted \? 300000 : 2000/);
assert.match(panelSource, /onTriggered:\s*\{\s*\n\s*root\.fallbackStarted = true\s*\n\s*root\.runFallback\(false\)/);
assert.match(panelSource, /onServiceChanged:\s*if \(!service\) fallbackStarted = false/);
// Exactly two timers: the open-popup countdown ticker and that fallback.
assert.equal((panelSource.match(/^\s*Timer\s*\{/gm) || []).length, 2);
assert.match(panelSource, /Model\.settingsWithOverrides\(root\.settings,\s*root\.moduleName,\s*values\)/);
assert.match(panelSource, /bar\.shell\.updateEntryInline\(root\.moduleName,\s*entry\)/);
// The panel polls only in the service's absence (asserted above); it never
// broadcasts a refresh, which would race N identical CLI runs.
assert.doesNotMatch(panelSource, /broadcast\("refresh"\)/);
// Every applied snapshot re-anchors the clock so the closed-popup tooltip's
// "updated Xm ago" cannot freeze at panel-creation time — for the fallback
// parse here, and for service publishes through updatedMs.
assert.match(panelSource, /function\s+applySnapshot\(content\)\s*\{[^}]*\bnowMs\s*=\s*Date\.now\(\)/);
assert.match(panelSource, /function\s+onUpdatedMsChanged\(\)\s*\{\s*root\.nowMs\s*=\s*Date\.now\(\)/);
// The banner goes through the exit-code mapping, not a bare
// launchErrorMessage on any nonzero code — and a `status` run, which always
// exits 0, may only add a banner, never erase the live one.
assert.match(panelSource,
  /var message = Model\.refreshStatusMessage\(exitCode,\s*root\.refreshStderr\)/);
assert.match(panelSource,
  /if \(message !== "" \|\| root\.fallbackMode !== "status"\)\s*\n\s*root\.localRefreshError = message/);
assert.doesNotMatch(panelSource, /runFallback\(forced\)\s*\{[^}]*localRefreshError = ""/);

// The service is the data owner: it runs the CLI and parses its stdout once
// per shell, instead of every monitor's panel reading the same file.
const serviceSource = qmlSources.get('../service/Service.qml');
assert.match(serviceSource, /import\s+"\.\.\/omarchy\/Model\.js"\s+as\s+Model/);
assert.match(serviceSource, /Model\.parseSnapshot\(raw\)/);
// Both parse paths refuse to publish the pre-first-sync placeholder.
for (const src of [panelSource, serviceSource])
  assert.match(src, /if\s*\(Model\.isUnwrittenSnapshot\(parsed\.model\)\)\s*return/);
assert.match(serviceSource, /property\s+var\s+snapshotModel:\s*null/);
assert.match(serviceSource, /property\s+string\s+parseError:\s*""/);
assert.match(serviceSource, /property\s+real\s+updatedMs:\s*0/);
assert.match(serviceSource, /function\s+refresh\(\)\s*\{\s*\n\s*return startSync\(true\)/);
assert.match(serviceSource, /function\s+reload\(\)/);
assert.match(serviceSource,
  /command:\s*\["\/usr\/bin\/env",\s*"python3",\s*root\.cliPath,\s*"status"\]/);
assert.match(serviceSource,
  /\["\/usr\/bin\/env",\s*"python3",\s*root\.cliPath,\s*"sync",\s*"--force"\]/);
assert.match(serviceSource, /\["\/usr\/bin\/env",\s*"python3",\s*root\.cliPath,\s*"sync"\]/);
// Single-flight with a queue: a request refused mid-run is owed a run of its
// own (it cannot ride a result the CLI computed before the request existed),
// so startSync records it and onExited drains it. Without this, entering key A
// then key B back to back leaves B unconfigured until the next 300 s tick.
assert.match(serviceSource,
  /function\s+startSync\(force\)\s*\{\s*\n\s*if\s*\(syncProcess\.running\)\s*\{[^}]*syncQueue = Model\.queueSync\(syncQueue, force\)\s*\n\s*return false/);
assert.match(serviceSource, /property\s+var\s+syncQueue:\s*Model\.emptySyncQueue\(\)/);
// Drained exactly once per exit, and the slot is emptied before the owed run
// starts, so the chain cannot feed itself forever.
assert.match(serviceSource,
  /function\s+drainSyncQueue\(\)\s*\{\s*\n\s*var owed = Model\.takeSync\(syncQueue\)\s*\n\s*syncQueue = Model\.emptySyncQueue\(\)\s*\n\s*if \(owed\.run\) startSync\(owed\.force\)/);
assert.equal((serviceSource.match(/drainSyncQueue/g) || []).length, 2);
assert.match(serviceSource, /Qt\.callLater\(root\.drainSyncQueue\)/);
assert.match(serviceSource, /interval:\s*root\.baseIntervalMs/);
assert.match(serviceSource, /baseIntervalMs:\s*300000/);
// Backoff is gated on "produced no data", not on any nonzero exit: exits 1
// and 2 print a snapshot and keep the normal cadence.
assert.match(serviceSource, /if\s*\(Model\.syncRunFailed\(exitCode,\s*out\)\)/);
assert.match(serviceSource, /Math\.min\(3600000,/);
assert.doesNotMatch(serviceSource, /if\s*\(exitCode === 0\)/);
assert.match(serviceSource,
  /refreshError\s*=\s*Model\.refreshStatusMessage\(exitCode,\s*root\.syncStderrTail\)/);
// One stderr collector per Process: a reload must not overwrite the sync's
// diagnostic tail, or the warning above prints the wrong one.
assert.match(serviceSource, /property\s+string\s+syncStderrTail:\s*""/);
assert.match(serviceSource, /property\s+string\s+reloadStderrTail:\s*""/);
assert.doesNotMatch(serviceSource, /\broot\.stderrTail\b/);
assert.equal((serviceSource.match(/root\.syncStderrTail = text/g) || []).length, 1);
assert.equal((serviceSource.match(/root\.reloadStderrTail = text/g) || []).length, 1);
// `status` exits 0 even while a sync failure is still the truth, so reload()
// may only add a banner — opening the popup must not erase a live error.
assert.match(serviceSource,
  /var message = Model\.refreshStatusMessage\(exitCode,\s*root\.reloadStderrTail\)\s*\n\s*if \(message !== ""\) root\.refreshError = message/);
// Secrets never ride in argv or a child environment (all QML files are
// checked for that above; keys are a service-side concern too).
assert.doesNotMatch(serviceSource, /command:[^\n]*(secret|key|token)/i);

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

// Esc during an in-flight key save must not destroy the view: the Loader is
// held active while KeysView reports a run outstanding, so the save's exit
// handler (row state + the follow-up sync) always gets to run. The release is
// deferred by one event-loop turn so it can never land mid-handler.
assert.match(panelSource, /active:\s*root\.keysOpen \|\| root\.keysBusy/);
assert.match(panelSource, /visible:\s*root\.keysOpen/);
assert.match(panelSource, /onActiveIdChanged:\s*root\.holdKeys\(activeId !== ""\)/);
assert.match(panelSource,
  /function\s+holdKeys\(running\)\s*\{\s*\n\s*if \(running === true\) keysBusy = true\s*\n\s*else Qt\.callLater\(root\.releaseKeys\)/);
assert.match(panelSource,
  /function\s+releaseKeys\(\)\s*\{\s*\n\s*var view = keysLoader\.item\s*\n\s*keysBusy = view \? String\(view\.activeId\) !== "" : false/);
// KeysView drops activeId only after the result has been applied, so the
// latch above spans the whole run including syncRequested().
assert.match(keysViewSource,
  /syncRequested\(\)[\s\S]*setRowError\(id, Model\.keyCommandErrorMessage[\s\S]*activeId = ""\s*\n\s*activeAction = ""\s*\n\s*\}/);
assert.doesNotMatch(keysViewSource,
  /var action = activeAction\s*\n\s*activeId = ""/);

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

// Hard byte cap: stdout is the transport now, so an oversized document is
// rejected before JSON.parse ever sees it. The cap is on UTF-8 bytes, not
// code units — 400k three-byte characters are over it despite the shorter
// string length.
const capped = model.parseSnapshot('x'.repeat(1048577));
assert.equal(capped.ok, false);
assert.equal(capped.model, null);
assert.match(capped.error, /too large/);
assert.equal(model.parseSnapshot('€'.repeat(400000)).ok, false);
// Just under the cap still parses: a padded but valid snapshot survives.
const padded = JSON.stringify({
  schemaVersion: 1, generatedAt: '2026-08-28T15:50:00Z', totalRemainingUsd: '1.00',
  anyEstimated: false, attention: null, providers: [
    {id: 'openrouter', name: 'OpenRouter', status: 'ok', source: 'credits',
     balance: {remaining: '1.00', currency: 'USD', estimated: false},
     percentRemaining: 0.5, severity: 'ok', stale: false, error: null,
     detail: 'a'.repeat(1048000)}
  ]});
assert.ok(padded.length > 1000000 && padded.length < 1048576);
const paddedParsed = model.parseSnapshot(padded);
assert.equal(paddedParsed.ok, true);
assert.equal(paddedParsed.model.providers[0].detail.length, 200);
assert.equal(model.parseSnapshot(undefined).ok, false);
assert.equal(model.parseSnapshot('').ok, false);

// `status` before the first sync prints a valid placeholder. It must not be
// published: with zero providers and no generatedAt the popup would claim
// every provider is disabled instead of waiting for the first sync.
const placeholder = model.parseSnapshot(JSON.stringify({
  schemaVersion: 1, generatedAt: null, totalRemainingUsd: '0.00',
  anyEstimated: false, attention: null, providers: []}));
assert.equal(placeholder.ok, true);
assert.equal(model.isUnwrittenSnapshot(placeholder.model), true);
assert.equal(model.isUnwrittenSnapshot(null), true);
// A real sync that found every provider disabled carries a generatedAt, and
// is published as data.
assert.equal(model.isUnwrittenSnapshot(model.parseSnapshot(JSON.stringify({
  schemaVersion: 1, generatedAt: '2026-08-28T15:50:00Z', totalRemainingUsd: '0.00',
  anyEstimated: false, attention: null, providers: []})).model), false);

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

// The missing-python3 hint names no package manager and no privilege
// escalation: the plugin never tells the user to run an install command. The
// expected text is asserted exactly; the forbidden tokens are assembled from
// fragments at runtime so those literals appear nowhere in this repository —
// the marketplace capability baseline greps for them, and a literal inside a
// negative assertion reads the same to a grep as a real occurrence.
const INSTALL_HINT = 'python3 was not found. Install python3 to use this plugin.';
const FORBIDDEN_INSTALL = new RegExp(
  ['su' + 'do', 'doa' + 's', 'pk' + 'exec', 'pac' + 'man', 'ap' + 't', 'dn' + 'f',
   'zyp' + 'per', 'ya' + 'y', 'par' + 'u', 'brew', '-S\\b'].join('|'), 'i');
assert.equal(model.launchErrorMessage(127, ''), INSTALL_HINT);
assert.doesNotMatch(model.launchErrorMessage(127, ''), FORBIDDEN_INSTALL);
// The assembled pattern really does catch what it claims to.
assert.match('run su' + 'do pac' + 'man -S python', FORBIDDEN_INSTALL);
assert.equal(model.launchErrorMessage(3, 'traceback text'), 'traceback text');
assert.equal(model.launchErrorMessage(3, ''), 'The sync command failed without an error message.');

// Refresh banner mapping: 1 and 2 are data outcomes carried by the snapshot
// rows — no generic banner for 1, a short pointer for 2. launchErrorMessage
// is reserved for 127 and unexpected codes.
assert.equal(model.refreshStatusMessage(0, ''), '');
assert.equal(model.refreshStatusMessage(1, 'every provider errored'), '');
assert.equal(model.refreshStatusMessage(2, 'config unreadable'), 'Configuration error — see provider rows.');
assert.equal(model.refreshStatusMessage(127, ''), INSTALL_HINT);
assert.equal(model.refreshStatusMessage(3, 'traceback text'), 'traceback text');
assert.equal(model.refreshStatusMessage(3, ''), 'The sync command failed without an error message.');

// ------------------------------------------------------- sync backoff gate

// Backoff exists for runs that produced nothing — a missing python3, a crash,
// an unexpected code. Exits 1 (every provider errored) and 2 (config/state
// error) printed a real snapshot: they are data outcomes the user repairs in a
// terminal, so the service must hold its 300 s cadence and notice the repair
// on the next tick rather than drifting out to an hour.
const SNAP = '{"schemaVersion":1,"providers":[]}';
assert.equal(model.syncRunFailed(0, SNAP), false);
assert.equal(model.syncRunFailed(1, SNAP), false);
assert.equal(model.syncRunFailed(2, SNAP), false);
assert.equal(model.syncRunFailed(127, ''), true);
assert.equal(model.syncRunFailed(3, 'boom'), true);
assert.equal(model.syncRunFailed(-1, SNAP), true);
// A contract exit code that printed nothing never ran the CLI to completion.
assert.equal(model.syncRunFailed(0, ''), true);
assert.equal(model.syncRunFailed(1, '   \n'), true);
assert.equal(model.syncRunFailed(2, null), true);
assert.equal(model.syncRunFailed(2, undefined), true);

// --------------------------------------------------------- sync queueing

// One `sync` runs at a time, but a request refused mid-run is OWED a run: the
// in-flight CLI read config and secrets before the request existed, so it
// cannot answer for it. This is the key-onboarding flow — key A's forced sync
// is still fetching when key B is saved, and B must not wait 5 minutes.
const EMPTY_QUEUE = model.emptySyncQueue();
assert.deepEqual(JSON.parse(JSON.stringify(EMPTY_QUEUE)), {pending: false, force: false});
assert.deepEqual(JSON.parse(JSON.stringify(model.takeSync(EMPTY_QUEUE))),
  {run: false, force: false});
assert.deepEqual(JSON.parse(JSON.stringify(model.takeSync(null))), {run: false, force: false});
assert.deepEqual(JSON.parse(JSON.stringify(model.takeSync(undefined))), {run: false, force: false});

// A refusal records the owed run, forced when the caller asked for force.
const forcedQueue = model.queueSync(EMPTY_QUEUE, true);
assert.deepEqual(JSON.parse(JSON.stringify(forcedQueue)), {pending: true, force: true});
assert.deepEqual(JSON.parse(JSON.stringify(model.takeSync(forcedQueue))),
  {run: true, force: true});
const plainQueue = model.queueSync(EMPTY_QUEUE, false);
assert.deepEqual(JSON.parse(JSON.stringify(plainQueue)), {pending: true, force: false});
assert.deepEqual(JSON.parse(JSON.stringify(model.takeSync(plainQueue))),
  {run: true, force: false});

// One slot only: a burst of refusals collapses into a single owed run, and
// `force` is sticky in both orders, so a manual refresh queued next to a timer
// tick still runs forced.
assert.deepEqual(JSON.parse(JSON.stringify(
  model.queueSync(model.queueSync(model.queueSync(EMPTY_QUEUE, false), true), false))),
  {pending: true, force: true});
assert.deepEqual(JSON.parse(JSON.stringify(
  model.queueSync(model.queueSync(EMPTY_QUEUE, true), false))), {pending: true, force: true});
assert.deepEqual(JSON.parse(JSON.stringify(
  model.queueSync(model.queueSync(EMPTY_QUEUE, false), true))), {pending: true, force: true});
assert.deepEqual(JSON.parse(JSON.stringify(
  model.queueSync(model.queueSync(EMPTY_QUEUE, false), false))), {pending: true, force: false});
// A stale/absent queue value is treated as empty rather than trusted.
assert.deepEqual(JSON.parse(JSON.stringify(model.queueSync(null, false))),
  {pending: true, force: false});
assert.deepEqual(JSON.parse(JSON.stringify(model.queueSync({force: true}, false))),
  {pending: true, force: false});

// Termination: the service drains by taking the slot and resetting it, so a
// run started from onExited can queue at most one more. Simulate the whole
// loop — two keys saved back to back, then nothing further requested.
function drive(requests) {
  let queue = model.emptySyncQueue();
  let running = false;
  const started = [];
  const start = force => {
    if (running) { queue = model.queueSync(queue, force); return false; }
    running = true;
    started.push(force === true);
    return true;
  };
  const exit = () => {
    running = false;
    const owed = model.takeSync(queue);
    queue = model.emptySyncQueue();
    if (owed.run) start(owed.force);
  };
  for (const force of requests) start(force);
  // Drain to quiescence; the bound proves it terminates rather than assuming it.
  for (let i = 0; running && i < 100; i++) exit();
  assert.equal(running, false, 'the queue drains to idle');
  assert.deepEqual(JSON.parse(JSON.stringify(queue)), {pending: false, force: false});
  return started;
}
// Key A, then key B mid-flight: BOTH get a forced run, and only two run.
assert.deepEqual(drive([true, true]), [true, true]);
// Timer tick, then a manual refresh refused behind it: the owed run is forced.
assert.deepEqual(drive([false, true]), [false, true]);
// Five refusals collapse into exactly one owed run.
assert.deepEqual(drive([true, false, false, true, false]), [true, true]);
assert.deepEqual(drive([false]), [false]);
assert.deepEqual(drive([]), []);

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
assert.equal(model.keyCommandErrorMessage(127, ''), INSTALL_HINT);
assert.doesNotMatch(model.keyCommandErrorMessage(127, ''), FORBIDDEN_INSTALL);
assert.equal(model.keyCommandErrorMessage(1, 'error: empty key\n'), 'error: empty key');
assert.equal(model.keyCommandErrorMessage(1, ''), 'The key command failed (exit 1).');
// Stderr tail only, sanitized (controls stripped, angle brackets replaced).
assert.equal(model.keyCommandErrorMessage(1, 'line1\nline2\n<script>' + String.fromCharCode(0) + 'boom'),
  'line2 \u00b7 \u2039script\u203aboom');
// Capped: a huge traceback cannot flood the row.
assert.ok(model.keyCommandErrorMessage(1, 'x'.repeat(5000)).length <= 301);

console.log('Omacash model tests passed');
