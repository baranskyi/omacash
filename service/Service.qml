import QtQuick
import Quickshell.Io
import "../omarchy/Model.js" as Model

// Data owner for io.github.baranskyi.omacash. Mounted once per shell (bar
// widgets and panels exist per monitor), so the CLI runs and the JSON parse
// happen exactly once no matter how many screens are attached.
//
// SECURITY: no QML object in this plugin ever opens a state path. The CLI is
// the only reader of config, secrets, cache, alerts, and the snapshot — it
// performs the bounded, no-follow, owner-checked reads and establishes its own
// directories. Content reaches this long-lived shell process only as the
// stdout of a process we spawned, and is bounded again by
// Model.parseSnapshot before anything is published to the UI.
//
// The 5-minute tick runs the CLI's `sync`; its own per-provider TTL gate (read
// from its config.json) decides what actually refreshes, so the real cadence
// stays config-driven without this service parsing that config.
Item {
  id: root

  property var shell: null
  property var manifest: null

  // This file lives in service/, so the plugin root is one level up.
  readonly property string pluginDir: Qt.resolvedUrl("..").toString()
    .replace(/^file:\/\//, "").replace(/\/$/, "")
  readonly property string cliPath: pluginDir + "/bin/omacash"

  // Published state. Panel.qml binds to these through shell.serviceFor().
  property var snapshotModel: null
  property string parseError: ""
  property string refreshError: ""
  // Wall clock of the last accepted model, so panels can re-anchor their
  // "updated Xm ago" text without watching anything on disk.
  property real updatedMs: 0
  readonly property bool busy: syncProcess.running || reloadProcess.running

  readonly property int baseIntervalMs: 300000
  property int failureCount: 0
  // Forced runs and the timer's run share one Process: whichever starts first
  // wins. A request arriving mid-run is *owed* a run of its own rather than
  // riding the in-flight result — see Model.queueSync — and takes the single
  // pending slot below.
  property bool forceRequested: false
  property var syncQueue: Model.emptySyncQueue()
  property string syncStdout: ""
  property string reloadStdout: ""
  // One collector per Process: a sync's diagnostic tail must not be destroyed
  // by a later reload, or the warning below prints the wrong stderr.
  property string syncStderrTail: ""
  property string reloadStderrTail: ""

  // Publishes a snapshot document that arrived as CLI stdout. Empty output is
  // not a parse failure: the exit code carries the reason (a missing python3
  // prints nothing at all), so the launch banner must not be overwritten.
  function applySnapshot(content) {
    var raw = String(content || "")
    if (raw.trim() === "") return false
    var parsed = Model.parseSnapshot(raw)
    if (!parsed.ok) {
      parseError = parsed.error
      return false
    }
    // A pre-first-sync placeholder is not data; keep showing "waiting".
    if (Model.isUnwrittenSnapshot(parsed.model)) return false
    snapshotModel = parsed.model
    parseError = ""
    updatedMs = Date.now()
    return true
  }

  function startSync(force) {
    if (syncProcess.running) {
      // Owed, not dropped: the in-flight run loaded config and secrets before
      // this request existed, so it cannot answer for it (entering a second
      // API key while the first key's sync is still fetching).
      syncQueue = Model.queueSync(syncQueue, force)
      return false
    }
    forceRequested = force === true
    syncStderrTail = ""
    syncStdout = ""
    syncProcess.running = true
    return true
  }

  // Starts the run owed to requests that were refused while a run was in
  // flight. The slot holds one entry and is cleared before the run starts, so
  // a run launched from onExited can queue at most one more — never a loop.
  function drainSyncQueue() {
    var owed = Model.takeSync(syncQueue)
    syncQueue = Model.emptySyncQueue()
    if (owed.run) startSync(owed.force)
  }

  // Manual refresh (panel button, `r`, right-click, IPC, a saved key).
  function refresh() {
    return startSync(true)
  }

  // Cheap re-read with no network: re-publishes whatever the CLI last wrote,
  // picking up a snapshot produced by a terminal run of the CLI.
  function reload() {
    if (busy) return false
    reloadStdout = ""
    reloadProcess.running = true
    return true
  }

  Component.onCompleted: startSync(false)

  Component.onDestruction: {
    if (syncProcess.running) syncProcess.running = false
    if (reloadProcess.running) reloadProcess.running = false
  }

  Timer {
    id: syncTimer
    interval: root.baseIntervalMs
    running: true
    repeat: true
    onTriggered: root.startSync(false)
  }

  Process {
    id: syncProcess
    running: false
    // /usr/bin/env reports a missing python3 as exit 127 instead of the
    // process silently never starting. Secrets never appear here: the CLI
    // reads its own secrets file. Both arms are fixed constant arrays.
    command: root.forceRequested
      ? ["/usr/bin/env", "python3", root.cliPath, "sync", "--force"]
      : ["/usr/bin/env", "python3", root.cliPath, "sync"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.syncStdout = text
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.syncStderrTail = text.slice(-500)
    }

    onExited: function(exitCode) {
      var out = root.syncStdout
      root.syncStdout = ""
      // Exit 1 (every provider errored) and 2 (config unreadable) are data
      // outcomes — the snapshot rows carry the detail — so no generic banner.
      root.refreshError = Model.refreshStatusMessage(exitCode, root.syncStderrTail)
      root.applySnapshot(out)
      if (Model.syncRunFailed(exitCode, out)) {
        root.failureCount++
        // Changing the interval restarts the running timer, so each run that
        // produced nothing pushes the next attempt out: 10m, 20m, 40m, 1h cap.
        syncTimer.interval = Math.min(3600000,
          root.baseIntervalMs * Math.pow(2, Math.min(root.failureCount, 4)))
        console.warn("omacash: sync exited", exitCode,
          String(root.syncStderrTail || "").trim())
      } else {
        // Exits 1 and 2 printed a snapshot: they are data outcomes the user
        // repairs in a terminal, so hold the normal cadence and pick the
        // repair up on the next tick instead of up to an hour later.
        root.failureCount = 0
        syncTimer.interval = root.baseIntervalMs
      }
      // Deferred one event-loop turn so this Process is idle again before the
      // owed run tries to claim it.
      Qt.callLater(root.drainSyncQueue)
    }
  }

  Process {
    id: reloadProcess
    running: false
    command: ["/usr/bin/env", "python3", root.cliPath, "status"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.reloadStdout = text
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.reloadStderrTail = text.slice(-500)
    }

    onExited: function(exitCode) {
      var out = root.reloadStdout
      root.reloadStdout = ""
      // `status` exits 0 even while the last sync's failure is still the
      // truth, so a reload may only ADD a banner, never clear one — opening
      // the popup must not erase the error the user came to read. Only a sync
      // reports that a run succeeded in producing fresh data.
      var message = Model.refreshStatusMessage(exitCode, root.reloadStderrTail)
      if (message !== "") root.refreshError = message
      root.applySnapshot(out)
    }
  }
}
