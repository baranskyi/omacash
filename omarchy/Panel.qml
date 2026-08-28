import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Popup + data host. BarWidget.qml owns the bar slot and injects its button
// as this panel's anchor. The only data source is snapshot.json written by
// the CLI (driven by service/Service.qml); this panel is a file watcher, not
// a poller — a manual refresh just runs the CLI once and rereads the file.
Panel {
  id: root
  moduleName: "io.github.baranskyi.balances"
  ipcTarget: "io.github.baranskyi.balances"
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
  readonly property string cliPath: pluginDir + "/bin/omarchy-balances"
  readonly property string snapshotPath: {
    var xdg = Quickshell.env("XDG_STATE_HOME")
    var base = xdg && String(xdg) !== "" ? String(xdg) : Quickshell.env("HOME") + "/.local/state"
    return base + "/omarchy/io.github.baranskyi.balances/snapshot.json"
  }

  property var snapshotModel: null
  property string parseError: ""
  property string refreshError: ""
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

  function applySnapshot(content) {
    // Re-anchor the clock on every snapshot so tooltip "updated Xm ago"
    // stays truthful while the popup is closed (its ticker only runs open).
    nowMs = Date.now()
    var parsed = Model.parseSnapshot(content)
    if (parsed.ok) {
      snapshotModel = parsed.model
      parseError = ""
    } else {
      parseError = parsed.error
    }
  }

  function barText() {
    if (!snapshotModel && parseError !== "") return vertical ? "!" : "$ !"
    return Model.barText(snapshotModel, pillMode, pinnedProvider, showLabel, vertical)
  }

  function tooltipText() {
    return Model.tooltipText(snapshotModel, nowMs)
  }

  function refresh() {
    if (refreshProcess.running) return
    refreshError = ""
    refreshStderr = ""
    refreshProcess.running = true
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

  function openSetup() {
    if (!bar) return
    var quoted = typeof bar.shellQuote === "function"
      ? bar.shellQuote(cliPath) : "'" + cliPath + "'"
    bar.run("omarchy-launch-floating-terminal-with-presentation python3 " + quoted + " setup")
    root.close()
  }

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(barIdentity, direction)
    return false
  }

  function statusMessage() {
    if (refreshError !== "") return refreshError
    if (parseError !== "") return parseError
    return ""
  }

  onOpenedChanged: {
    if (opened) {
      nowMs = Date.now()
      if (panelFlick) panelFlick.contentY = 0
      snapshotFile.reload()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    }
  }

  FileView {
    id: snapshotFile
    path: root.snapshotPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.applySnapshot(text())
    // Missing file before the first sync: keep waiting, the retry timer below
    // covers creation events the watcher cannot see.
    onLoadFailed: {}
  }

  Timer {
    interval: 15000
    running: root.snapshotModel === null
    repeat: true
    onTriggered: snapshotFile.reload()
  }

  // Keeps countdowns and "updated Xm ago" honest while the panel sits open.
  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  Process {
    id: refreshProcess
    running: false
    command: ["/usr/bin/env", "python3", root.cliPath, "sync", "--force"]

    stdout: StdioCollector {
      waitForEnd: true
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.refreshStderr = text
    }

    onExited: function(exitCode) {
      // Exit 1 (every provider errored) and 2 (config unreadable) are data
      // outcomes — the snapshot rows carry the detail — so no generic banner.
      root.refreshError = Model.refreshStatusMessage(exitCode, root.refreshStderr)
      snapshotFile.reload()
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
      // Local instance only; peers converge via the snapshot.json watcher.
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
                enabled: !refreshProcess.running
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

          Text {
            visible: root.snapshotModel === null && root.parseError === ""
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
            visible: root.snapshotModel !== null && root.rows.length === 0
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
            visible: root.rows.length > 0
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
              enabled: !refreshProcess.running
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              verticalPadding: Style.spacing.controlPaddingY
              onClicked: root.refresh()
            }

            Button {
              visible: root.anyUnconfigured
              text: "Set up keys"
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              verticalPadding: Style.spacing.controlPaddingY
              onClicked: root.openSetup()
            }
          }

          Text {
            visible: refreshProcess.running
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

  component ProviderRow: Column {
    id: providerRow
    property var row: null

    spacing: Style.space(6)
    opacity: row && row.greyed ? 0.55 : 1

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
