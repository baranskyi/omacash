import QtQuick
import Quickshell
import Quickshell.Io

// Background publisher for io.github.baranskyi.omacash. Runs the bundled CLI's
// `sync` on a fixed 5-minute tick; the CLI's own per-provider TTL gate (read
// from its config.json) decides what actually refreshes, so the real cadence
// is config-driven without this service parsing that config. The CLI writes
// snapshot.json (watched by Panel.qml) and the Agents-panel usage records.
Item {
  id: root

  property var shell: null
  property var manifest: null

  // This file lives in service/, so the plugin root is one level up.
  readonly property string pluginDir: Qt.resolvedUrl("..").toString()
    .replace(/^file:\/\//, "").replace(/\/$/, "")
  readonly property string cliPath: pluginDir + "/bin/omacash"

  readonly property string stateBase: {
    var xdg = Quickshell.env("XDG_STATE_HOME")
    var base = xdg && String(xdg) !== "" ? String(xdg) : Quickshell.env("HOME") + "/.local/state"
    return base + "/omarchy"
  }
  readonly property string stateDir: stateBase + "/io.github.baranskyi.omacash"
  readonly property string usageDir: stateBase + "/agents/usage"

  readonly property int baseIntervalMs: 300000
  property int failureCount: 0
  property string stderrTail: ""
  property bool prepared: false

  function startSync() {
    if (!prepared || syncProcess.running) return
    stderrTail = ""
    syncProcess.running = true
  }

  Component.onCompleted: prepareProcess.running = true

  Component.onDestruction: {
    if (prepareProcess.running) prepareProcess.running = false
    if (syncProcess.running) syncProcess.running = false
  }

  // The panel and the Agents panel both discover records by watching these
  // directories, and this service can win the race to create them.
  Process {
    id: prepareProcess
    running: false
    command: ["mkdir", "-p", root.stateDir, root.usageDir]
    onExited: {
      root.prepared = true
      root.startSync()
    }
  }

  Timer {
    id: syncTimer
    interval: root.baseIntervalMs
    running: true
    repeat: true
    onTriggered: root.startSync()
  }

  Process {
    id: syncProcess
    running: false
    // /usr/bin/env reports a missing python3 as exit 127 instead of the
    // process silently never starting. Secrets never appear here: the CLI
    // reads its own secrets.json.
    command: ["/usr/bin/env", "python3", root.cliPath, "sync"]

    stdout: StdioCollector {
      // The CLI prints the snapshot; the panel reads it from disk instead.
      waitForEnd: true
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.stderrTail = text.slice(-500)
    }

    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.failureCount = 0
        syncTimer.interval = root.baseIntervalMs
        return
      }
      root.failureCount++
      // Changing the interval restarts the running timer, so each failure
      // pushes the next attempt out: 10m, 20m, 40m, capped at 1h.
      syncTimer.interval = Math.min(3600000,
        root.baseIntervalMs * Math.pow(2, Math.min(root.failureCount, 4)))
      console.warn("balances: sync exited", exitCode,
        String(root.stderrTail || "").trim())
    }
  }
}
