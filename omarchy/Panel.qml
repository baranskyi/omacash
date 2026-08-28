import QtQuick
import QtQuick.Controls
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Popup view. BarWidget.qml owns the bar slot and injects its button as this
// panel's anchor. This panel owns no data: service/Service.qml (one instance
// per shell) runs the CLI and publishes the parsed model, and this panel binds
// to it through shell.serviceFor(). Nothing here ever opens a file — when the
// service is missing the fallback still goes through the CLI's stdout.
Panel {
  id: root
  moduleName: "io.github.baranskyi.omacash"
  ipcTarget: "io.github.baranskyi.omacash"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.45)
  // No amber token exists in qs.Commons; a fixed amber reads on both themes.
  readonly property color warningColor: Qt.rgba(0.85, 0.62, 0.2, 1)
  readonly property color track: Style.selectedFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool vertical: bar ? bar.vertical : false

  readonly property string pluginDir: Qt.resolvedUrl("..").toString()
    .replace(/^file:\/\//, "").replace(/\/$/, "")
  readonly property string cliPath: pluginDir + "/bin/omacash"

  // The single shell-wide service instance owns the CLI runs and the parse.
  // Null while it is still loading, or if the plugin's service failed to
  // mount — the fallback below covers that case without reading any file.
  readonly property var service: bar?.shell?.serviceFor("io.github.baranskyi.omacash") ?? null

  // Fallback state, used only while service === null.
  property var fallbackModel: null
  property string fallbackError: ""
  // Which CLI verb the fallback Process runs. "force": the user asked for
  // fresh numbers. "sync": there is nothing to show yet, so only a network run
  // can fill the pill — `status` would just re-print the pre-first-sync
  // placeholder, which is never published. "status": cheap network-free
  // re-read of what the CLI last wrote.
  property string fallbackMode: "status"
  // Set once the service-less convergence timer has taken its first run, which
  // switches that timer from its short startup settle to the 300 s cadence.
  property bool fallbackStarted: false

  readonly property var snapshotModel: service ? service.snapshotModel : fallbackModel
  readonly property string parseError: service ? service.parseError : fallbackError
  readonly property string refreshError: service ? service.refreshError : localRefreshError
  readonly property bool refreshing: service ? service.busy === true : fallbackProcess.running

  property bool keysOpen: false
  // Latched while KeysView has a `key set`/`key clear` run outstanding, so Esc
  // cannot unload the view (and with it the Process) before the result lands.
  property bool keysBusy: false
  property string localRefreshError: ""
  property string refreshStderr: ""
  property double nowMs: Date.now()

  readonly property string pillMode: Model.pillModeSetting(setting("pillMode", "total"))
  readonly property string pinnedProvider: String(setting("pinnedProvider", "openrouter") || "openrouter").trim()
  readonly property bool showLabel: Model.booleanSetting(setting("showLabel", false), false)

  readonly property var rows: Model.providerRows(snapshotModel, nowMs)
  readonly property bool anyUnconfigured: Model.anyUnconfigured(snapshotModel)
  readonly property bool alarming: Model.alarming(snapshotModel) || parseError !== ""
  readonly property bool dimmedAll: Model.allStale(snapshotModel)

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value))
  }

  function alpha(color, opacity) {
    return Qt.rgba(color.r, color.g, color.b, opacity)
  }

  function roleColor(role) {
    if (role === "urgent") return urgent
    if (role === "warning") return warningColor
    if (role === "accent") return Color.accent
    if (role === "dim") return dim
    return foreground
  }

  // Fallback parse of the CLI's stdout (service === null only). The service
  // does the same for its own runs; either way the bytes come from a process
  // we spawned, never from a path this shell opened.
  function applySnapshot(content) {
    // Re-anchor the clock on every snapshot so tooltip "updated Xm ago"
    // stays truthful while the popup is closed (its ticker only runs open).
    nowMs = Date.now()
    var raw = String(content || "")
    if (raw.trim() === "") return
    var parsed = Model.parseSnapshot(raw)
    if (!parsed.ok) {
      fallbackError = parsed.error
      return
    }
    // A pre-first-sync placeholder is not data; keep showing "waiting".
    if (Model.isUnwrittenSnapshot(parsed.model)) return
    fallbackModel = parsed.model
    fallbackError = ""
  }

  function barText() {
    if (!snapshotModel && parseError !== "") return vertical ? "!" : "$ !"
    return Model.barText(snapshotModel, pillMode, pinnedProvider, showLabel, vertical)
  }

  function tooltipText() {
    return Model.tooltipText(snapshotModel, nowMs)
  }

  // Forced sync. The service single-flights it shell-wide; without a service
  // this instance runs the same CLI command itself.
  function refresh() {
    if (service) {
      service.refresh()
      return
    }
    runFallback(true)
  }

  // One CLI run, single-flighted. `sync --force` when the user asked for fresh
  // numbers; a plain `sync` while there is still nothing to show, since the
  // service that would normally have filled the pill is absent; otherwise
  // `status`, which never touches the network. The banner is not cleared here
  // — only the run's own outcome may do that (see onExited).
  function runFallback(forced) {
    if (fallbackProcess.running) return
    refreshStderr = ""
    fallbackMode = forced === true ? "force"
      : (fallbackModel === null ? "sync" : "status")
    fallbackProcess.running = true
  }

  function cyclePinned(step) {
    persistWidgetSettings({ pinnedProvider: Model.cyclePinned(snapshotModel, pinnedProvider, step) })
  }

  function resetPillMode() {
    if (pillMode !== "total") persistWidgetSettings({ pillMode: "total" })
  }

  function persistWidgetSettings(values) {
    var entry = Model.settingsWithOverrides(root.settings, root.moduleName, values)
    if (!entry) return false
    // Apply locally first so the pill responds even on hosts without
    // updateEntryInline; the shell then pushes the entry to every monitor.
    root.settings = entry
    if (hostWidget && "settings" in hostWidget) hostWidget.settings = entry
    if (bar && bar.shell && typeof bar.shell.updateEntryInline === "function")
      bar.shell.updateEntryInline(root.moduleName, entry)
    return true
  }

  function openKeys() {
    keysOpen = true
  }

  function closeKeys() {
    keysOpen = false
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  // Esc must not abort an in-flight `key set`/`key clear`: KeysView owns the
  // Process and the completion handling that flips the row and fires the
  // follow-up sync, so the Loader keeps it alive (hidden) until the run is
  // done. The release is deferred one event-loop turn so the view's own
  // onExited/finishRun always runs to completion before it may be dropped.
  function holdKeys(running) {
    if (running === true) keysBusy = true
    else Qt.callLater(root.releaseKeys)
  }

  function releaseKeys() {
    var view = keysLoader.item
    keysBusy = view ? String(view.activeId) !== "" : false
  }

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(barIdentity, direction)
    return false
  }

  function statusMessage() {
    var parts = []
    if (!service)
      parts.push("Background balance service is not running — this panel is refreshing on its own.")
    if (refreshError !== "") parts.push(refreshError)
    else if (parseError !== "") parts.push(parseError)
    return parts.join(" · ")
  }

  onOpenedChanged: {
    if (opened) {
      nowMs = Date.now()
      keysOpen = false
      if (panelFlick) panelFlick.contentY = 0
      // Cheap, network-free re-read so a snapshot written by a terminal run
      // of the CLI shows up when the popup opens.
      if (service) service.reload()
      else runFallback(false)
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    }
  }

  // The service publishes a new model by bumping updatedMs; re-anchor the
  // clock so the closed-popup tooltip's "updated Xm ago" cannot freeze.
  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onUpdatedMsChanged() { root.nowMs = Date.now() }
  }

  // Keeps countdowns and "updated Xm ago" honest while the panel sits open.
  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  // Service-less convergence. The shell-wide service normally owns every CLI
  // run; when it is absent this panel is the only thing that can fetch, so it
  // loads once shortly after the bar starts — not only when the popup is
  // opened — and then keeps the service's own 300 s cadence. `running` is
  // false whenever a service exists, so the CLI is never polled twice.
  Timer {
    id: fallbackTimer
    running: root.service === null
    repeat: true
    // The bar assigns `bar` just after this panel is created and the shell may
    // still be mounting the service, so settle briefly before concluding there
    // is none; after the first run this is the plain 300 s tick.
    interval: root.fallbackStarted ? 300000 : 2000
    onTriggered: {
      root.fallbackStarted = true
      root.runFallback(false)
    }
  }

  // A service that goes away (plugin reload) puts this panel back on the short
  // settle so it converges promptly instead of waiting out a whole tick.
  onServiceChanged: if (!service) fallbackStarted = false

  // Service-less fallback only. Every arm is a fixed constant array and the
  // snapshot arrives on stdout — this panel opens no path of its own.
  Process {
    id: fallbackProcess
    running: false
    command: root.fallbackMode === "force"
      ? ["/usr/bin/env", "python3", root.cliPath, "sync", "--force"]
      : root.fallbackMode === "sync"
        ? ["/usr/bin/env", "python3", root.cliPath, "sync"]
        : ["/usr/bin/env", "python3", root.cliPath, "status"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applySnapshot(text)
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.refreshStderr = text
    }

    onExited: function(exitCode) {
      // Exit 1 (every provider errored) and 2 (config unreadable) are data
      // outcomes — the snapshot rows carry the detail — so no generic banner.
      var message = Model.refreshStatusMessage(exitCode, root.refreshStderr)
      // `status` always exits 0, so a plain re-read may only ADD a banner,
      // never clear one: opening the popup must not erase a live sync error.
      if (message !== "" || root.fallbackMode !== "status")
        root.localRefreshError = message
    }
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string {
      // Local instance only; every panel reads the same shell-wide service.
      root.refresh()
      return "ok"
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Keys view: freeze the panel cursor while the view is open or one of
      // its TextFields is being edited (dev-gallery "Popups + editors" rule).
      // Esc then first leaves the keys view (handled inside KeysView), and
      // only the next Esc reaches this catcher and closes the panel.
      blocked: root.keysOpen || (keysLoader.item ? keysLoader.item.fieldFocused === true : false)

      onMoveRequested: function(dx, dy) {
        if (dy !== 0)
          panelFlick.contentY = root.clamp(panelFlick.contentY + dy * Style.space(56), 0,
            Math.max(0, panelFlick.contentHeight - panelFlick.height))
      }
      onActivateRequested: root.refresh()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "r" || text === "R") root.refresh()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: Model.totalText(root.snapshotModel)
            meta: Model.subtitle(root.snapshotModel, root.nowMs)
            foreground: root.foreground
            fontFamily: root.fontFamily

            iconComponent: Component {
              Text {
                text: "$"
                color: root.alarming ? root.urgent : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
                font.bold: true
              }
            }

            trailingControl: Component {
              PanelActionButton {
                iconText: "󰑐"
                tooltipText: "Refresh balances"
                foreground: root.foreground
                fontFamily: root.fontFamily
                enabled: !root.refreshing
                onClicked: root.refresh()
              }
            }
          }

          BorderSurface {
            readonly property string message: root.statusMessage()
            visible: message !== ""
            width: parent.width
            implicitHeight: statusText.implicitHeight + Style.spacing.xl * 2
            color: root.alpha(root.urgent, 0.09)
            borderSpec: Border.flat(root.alpha(root.urgent, 0.35), 1)
            radius: Style.cornerRadius

            Text {
              id: statusText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(12)
              anchors.rightMargin: Style.space(12)
              text: parent.message
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          Loader {
            id: keysLoader
            // Held loaded past an Esc while a key run is outstanding, so the
            // save always finishes and its follow-up sync always fires.
            active: root.keysOpen || root.keysBusy
            visible: root.keysOpen
            width: parent.width

            sourceComponent: KeysView {
              width: column.width
              foreground: root.foreground
              urgent: root.urgent
              fontFamily: root.fontFamily
              cliPath: root.cliPath
              snapshotModel: root.snapshotModel
              onCloseRequested: root.closeKeys()
              // The keys view reuses this panel's forced sync after every
              // successful key set/clear.
              onSyncRequested: root.refresh()
              // activeId is set before the Process starts and cleared only at
              // the end of finishRun, so it spans the whole run.
              onActiveIdChanged: root.holdKeys(activeId !== "")
            }

            onLoaded: Qt.callLater(function() {
              if (keysLoader.item) keysLoader.item.forceActiveFocus()
            })
          }

          Text {
            visible: !root.keysOpen && root.snapshotModel === null && root.parseError === ""
            width: parent.width
            topPadding: Style.space(16)
            text: "Waiting for the first sync…"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }

          Text {
            visible: !root.keysOpen && root.snapshotModel !== null && root.rows.length === 0
            width: parent.width
            topPadding: Style.space(16)
            text: "Every provider is disabled in config.json."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }

          Column {
            id: providerSection
            visible: !root.keysOpen && root.rows.length > 0
            width: parent.width
            spacing: Style.space(10)

            PanelSeparator {
              width: parent.width
              foreground: root.foreground
            }

            PanelSectionHeader {
              text: "PROVIDERS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.rows

              ProviderRow {
                required property var modelData
                width: providerSection.width
                row: modelData
              }
            }
          }

          PanelSeparator {
            width: parent.width
            foreground: root.foreground
          }

          Row {
            spacing: Style.spacing.md

            Button {
              text: "Refresh"
              bordered: true
              enabled: !root.refreshing
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              verticalPadding: Style.spacing.controlPaddingY
              onClicked: root.refresh()
            }

            Button {
              text: root.keysOpen ? "Back" : "Keys"
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              verticalPadding: Style.spacing.controlPaddingY
              onClicked: root.keysOpen ? root.closeKeys() : root.openKeys()
            }
          }

          Text {
            visible: root.refreshing
            width: parent.width
            text: "Refreshing…"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
          }
        }
      }
    }
  }

  component ProviderRow: Item {
    id: providerRow
    property var row: null

    implicitHeight: providerColumn.implicitHeight
    opacity: row && row.greyed ? 0.55 : 1

    Column {
      id: providerColumn
      width: parent.width
      spacing: Style.space(6)

      Item {
        width: parent.width
        implicitHeight: Math.max(nameText.implicitHeight, valueText.implicitHeight)

        Text {
          id: nameText
          text: providerRow.row ? providerRow.row.name : ""
          textFormat: Text.PlainText
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
          width: Math.min(implicitWidth, parent.width * 0.55)
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
        }

        Text {
          id: tierText
          text: providerRow.row ? providerRow.row.tier : ""
          textFormat: Text.PlainText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          anchors.left: nameText.right
          anchors.leftMargin: Style.spacing.sm
          anchors.right: valueText.left
          anchors.rightMargin: Style.spacing.sm
          anchors.verticalCenter: parent.verticalCenter
        }

        Text {
          id: valueText
          text: providerRow.row ? providerRow.row.value : ""
          textFormat: Text.PlainText
          color: providerRow.row && providerRow.row.valueRole !== ""
            ? root.roleColor(providerRow.row.valueRole) : root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
        }
      }

      Meter {
        visible: providerRow.row && providerRow.row.percent >= 0
        width: parent.width
        value: providerRow.row ? providerRow.row.percent : 0
        fill: providerRow.row ? root.roleColor(providerRow.row.meterRole) : root.foreground
      }

      Text {
        visible: text !== ""
        width: parent.width
        text: providerRow.row ? providerRow.row.sub : ""
        textFormat: Text.PlainText
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      Text {
        visible: text !== ""
        width: parent.width
        text: providerRow.row ? providerRow.row.note : ""
        textFormat: Text.PlainText
        color: providerRow.row ? root.roleColor(providerRow.row.noteRole) : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    // An unconfigured row is one-click entry into the keys view.
    MouseArea {
      anchors.fill: providerColumn
      visible: providerRow.row ? providerRow.row.greyed === true : false
      cursorShape: Qt.PointingHandCursor
      onClicked: root.openKeys()
    }
  }

  // The meter shows what is left: a prepaid balance drains toward empty.
  component Meter: Item {
    id: meter
    property real value: 0
    property color fill: root.foreground

    implicitHeight: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))

    Rectangle {
      id: meterTrack
      anchors.fill: parent
      radius: height / 2
      color: root.track
    }

    Rectangle {
      anchors.left: meterTrack.left
      anchors.verticalCenter: meterTrack.verticalCenter
      height: meterTrack.height
      radius: meterTrack.radius
      width: meterTrack.width * root.clamp(meter.value, 0, 1)
      color: meter.fill

      Behavior on width {
        NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
      }
    }
  }
}
