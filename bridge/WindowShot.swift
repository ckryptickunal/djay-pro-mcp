// Prints djay Pro's on-screen windows as JSON: [{id, name, bounds, onscreen}]
import CoreGraphics
import Foundation
let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "djay Pro"
let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var out: [[String: Any]] = []
for w in list where (w[kCGWindowOwnerName as String] as? String) == owner {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    out.append(["id": w[kCGWindowNumber as String] ?? 0, "name": w[kCGWindowName as String] ?? "", "layer": w[kCGWindowLayer as String] ?? 0,
                "onscreen": w[kCGWindowIsOnscreen as String] ?? false, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0, "pid": w[kCGWindowOwnerPID as String] ?? 0])
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
