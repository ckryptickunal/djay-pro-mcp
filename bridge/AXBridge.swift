// djay-ax-bridge: reads and drives djay Pro's accessibility tree.
//
// stdin  (one JSON object per line, each with an optional "id"):
//   {"op":"status"}                                   app running? pid, trusted, windows
//   {"op":"snapshot","rows":false,"maxNodes":4000}    flat node list of the main window
//   {"op":"press","label":"Sync, Deck 1","role":"AXButton","nth":0}
//   {"op":"press","path":[0,12]}
//   {"op":"setValue","label":"...","value":"text or number"}
//   {"op":"rows","start":0,"count":50}                visible library table rows (cell texts)
//   {"op":"selectRow","index":3}                      select a row in the library table
//   {"op":"menu","path":["File","Import"]}            press a menu bar item
//   {"op":"menus"}                                    list the menu bar tree (2 levels)
//   {"op":"focusSearch"} / {"op":"search","text":"daft punk"}
// stdout: {"id":..., "ok":true, "result":...} or {"id":..., "ok":false, "error":"..."}

import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let bundleID = "com.algoriddim.djay-iphone-free"

func reply(_ id: Any?, ok: Bool, result: Any? = nil, error: String? = nil) {
    var obj: [String: Any] = ["ok": ok]
    obj["id"] = id ?? NSNull()
    if let r = result { obj["result"] = r }
    if let e = error { obj["error"] = e }
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let line = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"error\":\"encode failed\"}")
        return
    }
    print(line)
}

func app() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first
}

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

func str(_ e: AXUIElement, _ name: String) -> String? {
    guard let v = attr(e, name) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func children(_ e: AXUIElement) -> [AXUIElement] {
    (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func actions(_ e: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(e, &names) == .success, let arr = names as? [String] else { return [] }
    return arr
}

func mainWindow() -> AXUIElement? {
    guard let a = app() else { return nil }
    let el = AXUIElementCreateApplication(a.processIdentifier)
    AXUIElementSetMessagingTimeout(el, 2.0)
    let wins = (attr(el, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    // Prefer the window titled "djay Pro" (the main window), else the first.
    return wins.first(where: { str($0, kAXTitleAttribute) == "djay Pro" }) ?? wins.first
}

struct Node {
    let el: AXUIElement
    let path: [Int]
}

let tableRoles: Set<String> = ["AXTable", "AXOutline"]

// Depth-first walk. Table/outline rows are skipped unless includeRows.
func walk(_ root: AXUIElement, includeRows: Bool, maxNodes: Int, visit: (Node, String) -> Void) {
    var stack: [Node] = [Node(el: root, path: [])]
    var count = 0
    while let n = stack.popLast(), count < maxNodes {
        count += 1
        let role = str(n.el, kAXRoleAttribute) ?? "?"
        visit(n, role)
        if !includeRows && tableRoles.contains(role) { continue }
        let kids = children(n.el)
        for (i, k) in kids.enumerated().reversed() { stack.append(Node(el: k, path: n.path + [i])) }
    }
}

func describe(_ n: Node, _ role: String) -> [String: Any] {
    var d: [String: Any] = ["path": n.path, "role": role]
    if let t = str(n.el, kAXTitleAttribute), !t.isEmpty { d["title"] = t }
    if let s = str(n.el, kAXDescriptionAttribute), !s.isEmpty { d["desc"] = s }
    if let v = str(n.el, kAXValueAttribute), !v.isEmpty { d["value"] = v }
    if let h = str(n.el, kAXHelpAttribute), !h.isEmpty { d["help"] = h }
    if let sub = str(n.el, kAXSubroleAttribute), !sub.isEmpty { d["subrole"] = sub }
    if let en = attr(n.el, kAXEnabledAttribute) as? Bool, !en { d["enabled"] = false }
    if let sel = attr(n.el, kAXSelectedAttribute) as? Bool, sel { d["selected"] = true }
    let acts = actions(n.el)
    if !acts.isEmpty { d["actions"] = acts }
    return d
}

func element(at path: [Int]) -> AXUIElement? {
    guard var cur = mainWindow() else { return nil }
    for i in path {
        let kids = children(cur)
        guard i >= 0 && i < kids.count else { return nil }
        cur = kids[i]
    }
    return cur
}

func find(label: String, role: String?, nth: Int, exact: Bool) -> AXUIElement? {
    guard let w = mainWindow() else { return nil }
    var hits: [AXUIElement] = []
    let needle = label.lowercased()
    walk(w, includeRows: false, maxNodes: 20000) { n, r in
        if let role = role, r != role { return }
        let labels = [str(n.el, kAXDescriptionAttribute), str(n.el, kAXTitleAttribute), str(n.el, kAXHelpAttribute)].compactMap { $0?.lowercased() }
        if labels.contains(where: { exact ? $0 == needle : $0.contains(needle) }) { hits.append(n.el) }
    }
    return nth < hits.count ? hits[nth] : nil
}

func resolve(_ msg: [String: Any]) -> AXUIElement? {
    if let p = msg["path"] as? [Int] { return element(at: p) }
    if let label = msg["label"] as? String {
        return find(label: label, role: msg["role"] as? String, nth: msg["nth"] as? Int ?? 0, exact: msg["exact"] as? Bool ?? true)
    }
    return nil
}

// Picks a table/outline by (partial) title; default is the main track list ("Playlist" table).
func libraryTable(_ name: String? = nil) -> AXUIElement? {
    guard let w = mainWindow() else { return nil }
    var tables: [(AXUIElement, String, String)] = []
    walk(w, includeRows: false, maxNodes: 20000) { n, r in
        if r == "AXTable" || r == "AXOutline" {
            let label = (str(n.el, kAXTitleAttribute) ?? str(n.el, kAXDescriptionAttribute) ?? "")
            tables.append((n.el, r, label))
        }
    }
    if let name = name?.lowercased(), !name.isEmpty {
        return tables.first(where: { $0.2.lowercased().contains(name) })?.0
    }
    return tables.first(where: { $0.1 == "AXTable" && $0.2 == "Playlist" })?.0
        ?? tables.first(where: { $0.1 == "AXTable" })?.0
}

func listTables() -> [[String: Any]] {
    guard let w = mainWindow() else { return [] }
    var out: [[String: Any]] = []
    walk(w, includeRows: false, maxNodes: 20000) { n, r in
        if r == "AXTable" || r == "AXOutline" {
            let rows = (attr(n.el, kAXRowsAttribute) as? [AXUIElement])?.count ?? 0
            out.append(["role": r, "title": str(n.el, kAXTitleAttribute) ?? str(n.el, kAXDescriptionAttribute) ?? "", "rows": rows, "path": n.path])
        }
    }
    return out
}

func texts(in e: AXUIElement, depth: Int = 0) -> [String] {
    if depth > 4 { return [] }
    var out: [String] = []
    let role = str(e, kAXRoleAttribute) ?? ""
    if role == "AXStaticText" || role == "AXTextField" {
        if let v = str(e, kAXValueAttribute), !v.isEmpty { out.append(v) }
        else if let t = str(e, kAXTitleAttribute), !t.isEmpty { out.append(t) }
    } else if let d = str(e, kAXDescriptionAttribute), !d.isEmpty, depth > 0, role == "AXImage" || role == "AXButton" {
        out.append("[\(d)]")
    }
    for k in children(e) { out += texts(in: k, depth: depth + 1) }
    return out
}

func tableAt(_ msg: [String: Any]) -> AXUIElement? {
    if let p = msg["tablePath"] as? [Int] { return element(at: p) }
    return libraryTable(msg["table"] as? String)
}

func rows(start: Int, count: Int, t: AXUIElement) -> [String: Any]? {
    let all = (attr(t, kAXRowsAttribute) as? [AXUIElement]) ?? []
    let cols = ((attr(t, kAXColumnsAttribute) as? [AXUIElement]) ?? []).map { c -> String in
        if let h = attr(c, kAXHeaderAttribute) { return str(h as! AXUIElement, kAXTitleAttribute) ?? str(c, kAXTitleAttribute) ?? "" }
        return str(c, kAXTitleAttribute) ?? str(c, kAXDescriptionAttribute) ?? ""
    }
    let sel = (attr(t, kAXSelectedRowsAttribute) as? [AXUIElement]) ?? []
    var out: [[String: Any]] = []
    let end = min(all.count, start + count)
    if start < end {
        for i in start..<end {
            let r = all[i]
            var cells: [[String]] = []
            for c in children(r) { cells.append(texts(in: c)) }
            out.append(["index": i, "cells": cells, "selected": sel.contains(where: { CFEqual($0, r) })])
        }
    }
    let title = str(t, kAXTitleAttribute) ?? str(t, kAXDescriptionAttribute) ?? ""
    return ["table": title, "total": all.count, "columns": cols, "rows": out]
}

func menuBar() -> AXUIElement? {
    guard let a = app() else { return nil }
    let el = AXUIElementCreateApplication(a.processIdentifier)
    guard let mb = attr(el, kAXMenuBarAttribute) else { return nil }
    return (mb as! AXUIElement)
}

func menuItems(_ menuOwner: AXUIElement) -> [AXUIElement] {
    // A menu bar item has one AXMenu child holding the items.
    let kids = children(menuOwner)
    if let m = kids.first, str(m, kAXRoleAttribute) == "AXMenu" { return children(m) }
    return kids
}

func listMenus() -> [[String: Any]] {
    guard let mb = menuBar() else { return [] }
    var out: [[String: Any]] = []
    for top in children(mb) {
        let title = str(top, kAXTitleAttribute) ?? ""
        if title.isEmpty || title == "Apple" { continue }
        var items: [Any] = []
        for it in menuItems(top) {
            let t = str(it, kAXTitleAttribute) ?? ""
            if t.isEmpty { continue }
            let sub = menuItems(it).compactMap { s -> String? in let x = str(s, kAXTitleAttribute) ?? ""; return x.isEmpty ? nil : x }
            let enabled = (attr(it, kAXEnabledAttribute) as? Bool) ?? true
            var d: [String: Any] = ["title": t, "enabled": enabled]
            if let mark = str(it, kAXMenuItemMarkCharAttribute), !mark.isEmpty { d["checked"] = true }
            if !sub.isEmpty { d["submenu"] = sub }
            items.append(d)
        }
        out.append(["menu": title, "items": items])
    }
    return out
}

func pressMenu(_ path: [String]) -> String? {
    guard var cur = menuBar(), !path.isEmpty else { return "no menu bar" }
    for (depth, name) in path.enumerated() {
        let pool = depth == 0 ? children(cur) : menuItems(cur)
        guard let next = pool.first(where: { (str($0, kAXTitleAttribute) ?? "").lowercased() == name.lowercased() }) else {
            return "menu item not found: \(name)"
        }
        cur = next
    }
    return AXUIElementPerformAction(cur, kAXPressAction as CFString) == .success ? nil : "press failed"
}

func setValue(_ e: AXUIElement, _ value: Any) -> AXError {
    if let s = value as? String { return AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, s as CFString) }
    if let n = value as? NSNumber { return AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, n) }
    return .illegalArgument
}

func handle(_ msg: [String: Any]) {
    let id = msg["id"]
    let op = msg["op"] as? String ?? ""
    let trusted = AXIsProcessTrusted()
    if op == "status" {
        let a = app()
        reply(id, ok: true, result: ["running": a != nil, "pid": a?.processIdentifier ?? 0, "trusted": trusted,
                                     "active": a?.isActive ?? false, "hidden": a?.isHidden ?? false,
                                     "version": a.flatMap { Bundle(url: $0.bundleURL!)?.infoDictionary?["CFBundleShortVersionString"] } ?? NSNull()])
        return
    }
    guard trusted else { reply(id, ok: false, error: "accessibility permission missing for this process"); return }
    guard app() != nil else { reply(id, ok: false, error: "djay Pro is not running"); return }

    switch op {
    case "snapshot":
        guard let w = mainWindow() else { reply(id, ok: false, error: "no djay window"); return }
        var nodes: [[String: Any]] = []
        walk(w, includeRows: msg["rows"] as? Bool ?? false, maxNodes: msg["maxNodes"] as? Int ?? 4000) { n, r in
            nodes.append(describe(n, r))
        }
        reply(id, ok: true, result: nodes)
    case "press":
        guard let e = resolve(msg) else { reply(id, ok: false, error: "element not found"); return }
        let action = msg["action"] as? String ?? kAXPressAction
        let r = AXUIElementPerformAction(e, action as CFString)
        r == .success ? reply(id, ok: true) : reply(id, ok: false, error: "AX action failed: \(r.rawValue)")
    case "setValue":
        guard let e = resolve(msg), let v = msg["value"] else { reply(id, ok: false, error: "element not found"); return }
        let r = setValue(e, v)
        r == .success ? reply(id, ok: true) : reply(id, ok: false, error: "AX set failed: \(r.rawValue)")
    case "focus":
        guard let e = resolve(msg) else { reply(id, ok: false, error: "element not found"); return }
        let r = AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        r == .success ? reply(id, ok: true) : reply(id, ok: false, error: "AX focus failed: \(r.rawValue)")
    case "rows":
        guard let t = tableAt(msg), let r = rows(start: msg["start"] as? Int ?? 0, count: msg["count"] as? Int ?? 50, t: t) else {
            reply(id, ok: false, error: "library table not visible"); return
        }
        reply(id, ok: true, result: r)
    case "tables":
        reply(id, ok: true, result: listTables())
    case "selectRow":
        guard let t = tableAt(msg) else { reply(id, ok: false, error: "library table not visible"); return }
        let all = (attr(t, kAXRowsAttribute) as? [AXUIElement]) ?? []
        let i = msg["index"] as? Int ?? -1
        guard i >= 0 && i < all.count else { reply(id, ok: false, error: "row index out of range (0..\(all.count - 1))"); return }
        var r = AXUIElementSetAttributeValue(all[i], kAXSelectedAttribute as CFString, kCFBooleanTrue)
        if r != .success { r = AXUIElementSetAttributeValue(t, kAXSelectedRowsAttribute as CFString, [all[i]] as CFArray) }
        r == .success ? reply(id, ok: true) : reply(id, ok: false, error: "select failed: \(r.rawValue)")
    case "menus":
        reply(id, ok: true, result: listMenus())
    case "menu":
        let err = pressMenu(msg["path"] as? [String] ?? [])
        err == nil ? reply(id, ok: true) : reply(id, ok: false, error: err)
    default:
        reply(id, ok: false, error: "unknown op \(op)")
    }
}

DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            reply(nil, ok: false, error: "bad input line")
            continue
        }
        DispatchQueue.main.sync { handle(msg) }
    }
    exit(0)
}

RunLoop.main.run()
