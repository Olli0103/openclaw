// Read the actual packaged app's accessibility tree. Guest permissions only.
import AppKit
import ApplicationServices
import Foundation

guard FileManager.default.fileExists(atPath: "/tmp/openclaw-native-disposable-20261005") else {
    fputs("Disposable guest marker required.\n", stderr); exit(2)
}
guard CommandLine.arguments.count >= 3, let pid = Int32(CommandLine.arguments[1]) else {
    fputs("usage: cron-ax PID dump|hover-automations|reopen|escape [X Y]\n", stderr); exit(2)
}
guard AXIsProcessTrusted() else {
    fputs("Grant this helper Accessibility permission inside the disposable guest; no proof was captured.\n", stderr); exit(3)
}
let action = CommandLine.arguments[2]
let app = AXUIElementCreateApplication(pid)
func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?; guard AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success else { return nil }; return value
}
func text(_ e: AXUIElement, _ key: String) -> String { attr(e, key) as? String ?? "" }
var nodes: [[String: Any]] = []
var elements: [(AXUIElement, [String: Any])] = []
func walk(_ element: AXUIElement, _ depth: Int) {
    guard depth <= 18, nodes.count < 1000 else { return }
    var row: [String: Any] = ["depth": depth, "role": text(element, kAXRoleAttribute), "title": text(element, kAXTitleAttribute), "description": text(element, kAXDescriptionAttribute), "help": text(element, kAXHelpAttribute)]
    if let position = attr(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID() {
        var point = CGPoint.zero
        if AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point) { row["x"] = Double(point.x); row["y"] = Double(point.y) }
    }
    if let size = attr(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() {
        var value = CGSize.zero
        if AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &value) { row["width"] = Double(value.width); row["height"] = Double(value.height) }
    }
    nodes.append(row); elements.append((element, row))
    if let children = attr(element, kAXChildrenAttribute) as? [AXUIElement] { for child in children { walk(child, depth + 1) } }
}
walk(app, 0)
if let menus = attr(app, kAXMenuBarAttribute), CFGetTypeID(menus) == AXUIElementGetTypeID() { walk(unsafeBitCast(menus, to: AXUIElement.self), 0) }
if let extras = attr(app, kAXExtrasMenuBarAttribute), CFGetTypeID(extras) == AXUIElementGetTypeID() { walk(unsafeBitCast(extras, to: AXUIElement.self), 0) }
if action == "close" {
    guard let (menu, _) = elements.first(where: { _, row in
        row["role"] as? String == "AXMenu" && (row["width"] as? Double ?? 0) > 0 && (row["height"] as? Double ?? 0) > 0
    }) else { fputs("No visible menu to cancel.\n", stderr); exit(4) }
    let result = AXUIElementPerformAction(menu, kAXCancelAction as CFString)
    print("AXCancel result: \(result.rawValue)")
    guard result == .success else { exit(5) }
} else if action == "dump" {
    let output: [String: Any] = ["wall": ISO8601DateFormatter().string(from: Date()), "pid": pid, "nodes": nodes]
    let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]); FileHandle.standardOutput.write(data); print("")
} else if action == "escape" {
    CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false)?.post(tap: .cghidEventTap)
} else {
    let wanted = action == "hover-automations" ? "Automations" : "OpenClaw"
    let candidate = elements.first { _, row in
        let role = row["role"] as? String ?? ""
        return ["title", "description", "help"].contains { (row[$0] as? String ?? "") == wanted } && (row["width"] as? Double ?? 0) > 0 && (row["height"] as? Double ?? 0) > 0 && row["x"] != nil && (action == "hover-automations" ? role == "AXMenuItem" : role == "AXMenuBarItem" || role == "AXButton")
    }
    let point: CGPoint
    if let (_, row) = candidate, let x = row["x"] as? Double, let y = row["y"] as? Double {
        point = CGPoint(x: x + (row["width"] as? Double ?? 1) / 2, y: y + (row["height"] as? Double ?? 1) / 2)
    } else if action == "reopen", CommandLine.arguments.count == 5, let x = Double(CommandLine.arguments[3]), let y = Double(CommandLine.arguments[4]) {
        point = CGPoint(x: x, y: y)
    } else { fputs("Required AX element not found. Inspect dump/screenshot and supply the actual status-item point for reopen.\n", stderr); exit(4) }
    if action == "hover-automations" {
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    } else if action == "reopen" {
        CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right)?.post(tap: .cghidEventTap)
        CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right)?.post(tap: .cghidEventTap)
    } else { exit(2) }
}
