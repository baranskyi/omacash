import QtQuick
import qs.Commons
import qs.Ui

// Bar entry point. The popup is loaded separately so this object owns shell
// routing (Bar.findPanelWidget needs open/close/opened here) while Panel.qml
// owns presentation. Neither reads any file: the plugin's service singleton
// runs the CLI and publishes the parsed model to every monitor's panel.
BarWidget {
  id: root
  moduleName: "io.github.baranskyi.omacash"

  readonly property var panelItem: panelLoader.item
  readonly property bool opened: panelItem ? panelItem.opened === true : false
  readonly property bool popoutSwitchClosing: panelItem
    ? panelItem.popoutSwitchClosing === true
    : false

  function open() {
    if (panelItem) panelItem.open()
  }

  function close() {
    if (panelItem) panelItem.close()
  }

  function toggle() {
    if (panelItem) panelItem.toggle()
  }

  function closeForPopoutSwitch() {
    if (panelItem) panelItem.closeForPopoutSwitch()
  }

  function refresh() {
    if (panelItem) panelItem.refresh()
  }

  function resetPillMode() {
    if (panelItem) panelItem.resetPillMode()
  }

  function injectPanel() {
    var target = panelItem
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.panelItem ? root.panelItem.barText() : "$ …"
    fontSize: Style.font.bodySmall
    active: root.panelItem ? root.panelItem.alarming : false
    dimmed: root.panelItem ? root.panelItem.dimmedAll : false
    tooltipText: root.panelItem ? root.panelItem.tooltipText() : "Omacash"
    horizontalMargin: 8.5

    onPressed: function(buttonCode) {
      // Refresh through this instance only; the shared service single-flights
      // the CLI run and publishes to every monitor, so a broadcast would just
      // race N identical requests.
      if (buttonCode === Qt.RightButton) root.refresh()
      else if (buttonCode === Qt.MiddleButton) root.resetPillMode()
      else root.toggle()
    }

    onWheelMoved: function(delta) {
      if (delta !== 0 && root.panelItem && root.panelItem.pillMode === "pinned")
        root.panelItem.cyclePinned(delta < 0 ? 1 : -1)
    }
  }
}
