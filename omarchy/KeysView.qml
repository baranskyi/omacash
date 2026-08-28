import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// In-panel API key entry, shown inside the balances popup (Panel.qml Loader).
//
// SECURITY: the key value lives only in the TextField and, between submit and
// process start, in pendingKey. It reaches the CLI exclusively over stdin —
// write(key + "\n") in saveProcess.onStarted — and never rides in argv, the
// environment, logs, or any persisted state. The Process command arrays below
// hold only fixed constants: cliPath plus a provider id out of
// Model.keyProviderIds(). `key set` reads stdin to EOF when it is not a TTY,
// so the write is followed by stdinEnabled = false to close the channel.
Column {
  id: root

  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property string fontFamily: Style.font.family
  property string cliPath: ""
  property var snapshotModel: null
  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property color accent: Color.accent

  // Provider id of the in-flight save/clear ("" when idle). Always one of the
  // fixed Model.keyProviderIds() constants — never user input.
  property string activeId: ""
  property string activeAction: ""
  // The submitted key, held only between submit and the stdin write in
  // saveProcess.onStarted, then dropped. The TextField is cleared on submit.
  property string pendingKey: ""
  property string savedId: ""
  property var rowErrors: ({})
  property string saveStderr: ""
  property string clearStderr: ""
  // Panel.qml binds PanelKeyCatcher.blocked to this (dev-gallery "Popups +
  // editors" rule) so j/k/r/Esc reach the focused field, not the panel.
  property Item focusedField: null
  readonly property bool fieldFocused: focusedField !== null
  // Single-flight: every Save/Clear is disabled while either process runs.
  readonly property bool busy: saveProcess.running || clearProcess.running

  signal closeRequested()
  signal syncRequested()

  spacing: Style.space(10)
  focus: visible
  Keys.onEscapePressed: closeRequested()

  function rowError(id) {
    return rowErrors && rowErrors[id] !== undefined ? String(rowErrors[id]) : ""
  }

  function setRowError(id, message) {
    var next = {}
    for (var key in rowErrors) next[key] = rowErrors[key]
    if (message === "") delete next[id]
    else next[id] = message
    rowErrors = next
  }

  function submitKey(id, field) {
    if (busy) return
    var key = String(field.text).trim()
    field.text = "" // the key never stays in the UI after submit
    setRowError(id, "")
    if (key === "") {
      setRowError(id, "The key field is empty.")
      return
    }
    activeId = id
    activeAction = "set"
    savedId = ""
    saveStderr = ""
    pendingKey = key
    saveProcess.stdinEnabled = true // reopened per run; closed after the write
    saveProcess.running = true
  }

  function clearKey(id) {
    if (busy) return
    setRowError(id, "")
    activeId = id
    activeAction = "clear"
    savedId = ""
    clearStderr = ""
    clearProcess.running = true
  }

  function finishRun(exitCode, stderrText) {
    var id = activeId
    var action = activeAction
    activeId = ""
    activeAction = ""
    if (Number(exitCode) === 0) {
      if (action === "set") {
        savedId = id
        savedTimer.restart()
      }
      // Reuse the panel's forced sync so the snapshot flips this row's state
      // and the bar pill updates.
      syncRequested()
    } else {
      setRowError(id, Model.keyCommandErrorMessage(exitCode, stderrText))
    }
  }

  Timer {
    id: savedTimer
    interval: 4000
    onTriggered: root.savedId = ""
  }

  Process {
    id: saveProcess
    running: false
    // Fixed constants only — the key itself goes over stdin (write below).
    command: ["/usr/bin/env", "python3", root.cliPath, "key", "set", root.activeId]
    stdinEnabled: true

    onStarted: {
      write(root.pendingKey + "\n")
      root.pendingKey = ""
      // `key set` reads stdin to EOF; closing the channel delivers the key.
      stdinEnabled = false
    }
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.saveStderr = text
    }
    onExited: function(exitCode) {
      root.pendingKey = ""
      root.finishRun(exitCode, root.saveStderr)
    }
  }

  Process {
    id: clearProcess
    running: false
    command: ["/usr/bin/env", "python3", root.cliPath, "key", "clear", root.activeId]

    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.clearStderr = text
    }
    onExited: function(exitCode) {
      root.finishRun(exitCode, root.clearStderr)
    }
  }

  PanelSectionHeader {
    text: "API KEYS"
    foreground: root.foreground
    fontFamily: root.fontFamily
  }

  Text {
    width: parent.width
    text: "Keys go to the CLI over stdin and are stored in secrets.json (mode 600). They never appear in process arguments, shell.json, or logs."
    textFormat: Text.PlainText
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  Repeater {
    model: Model.keyProviderIds()

    BorderSurface {
      id: card
      required property var modelData
      readonly property string providerId: String(modelData)
      readonly property var meta: Model.providerKeyMeta(providerId)
      readonly property bool isConfigured: Model.providerConfigured(root.snapshotModel, providerId)
      readonly property bool rowBusy: root.activeId === providerId
      readonly property string errorText: root.rowError(providerId)

      width: root.width
      implicitHeight: cardColumn.implicitHeight + Style.spacing.xl * 2
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
      borderSpec: Border.flat(Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.10), 1)
      radius: Style.cornerRadius

      Column {
        id: cardColumn
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: Style.space(12)
        anchors.rightMargin: Style.space(12)
        spacing: Style.space(6)

        Item {
          width: parent.width
          implicitHeight: Math.max(nameLabel.implicitHeight, stateLabel.implicitHeight)

          Text {
            id: nameLabel
            anchors.left: parent.left
            anchors.right: stateLabel.left
            anchors.rightMargin: Style.spacing.md
            text: card.meta ? card.meta.label : card.providerId
            textFormat: Text.PlainText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: true
            elide: Text.ElideRight
          }

          Text {
            id: stateLabel
            anchors.right: parent.right
            text: root.savedId === card.providerId ? "Saved ✓"
              : card.isConfigured ? "Configured ✓" : "Not set"
            textFormat: Text.PlainText
            color: root.savedId === card.providerId || card.isConfigured
              ? root.accent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        Text {
          width: parent.width
          text: card.meta ? card.meta.note : ""
          textFormat: Text.PlainText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        Text {
          text: "Open key page ↗"
          textFormat: Text.PlainText
          color: root.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.underline: linkArea.containsMouse

          MouseArea {
            id: linkArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: if (card.meta) Qt.openUrlExternally(card.meta.url)
          }
        }

        Text {
          visible: card.meta ? card.meta.needsLedger === true : false
          width: parent.width
          text: Model.ledgerHint(root.cliPath, card.providerId)
          textFormat: Text.PlainText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        Row {
          width: parent.width
          spacing: Style.space(8)

          TextField {
            id: keyField
            width: parent.width - saveButton.width - parent.spacing
              - (clearButton.visible ? clearButton.width + parent.spacing : 0)
            password: true
            enabled: !root.busy
            placeholderText: card.isConfigured ? "Paste a new key to replace" : "Paste API key"
            foreground: root.foreground
            onActiveFocusChanged: {
              if (activeFocus) root.focusedField = keyField
              else if (root.focusedField === keyField) root.focusedField = null
            }
            Keys.onEscapePressed: root.forceActiveFocus()
            onAccepted: root.submitKey(card.providerId, keyField)
          }

          Button {
            id: saveButton
            anchors.verticalCenter: keyField.verticalCenter
            text: card.rowBusy && root.activeAction === "set" ? "Saving…" : "Save"
            bordered: true
            focusable: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            verticalPadding: Style.spacing.controlPaddingY
            enabled: !root.busy
            onClicked: root.submitKey(card.providerId, keyField)
          }

          Button {
            id: clearButton
            visible: card.isConfigured
            anchors.verticalCenter: keyField.verticalCenter
            text: card.rowBusy && root.activeAction === "clear" ? "Clearing…" : "Clear"
            bordered: true
            focusable: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            verticalPadding: Style.spacing.controlPaddingY
            enabled: !root.busy
            onClicked: root.clearKey(card.providerId)
          }
        }

        Text {
          visible: card.errorText !== ""
          width: parent.width
          text: card.errorText
          textFormat: Text.PlainText
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }

  Text {
    width: parent.width
    text: "Esc returns to balances."
    textFormat: Text.PlainText
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    horizontalAlignment: Text.AlignHCenter
  }
}
