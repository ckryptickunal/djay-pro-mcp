// djay-midi-bridge: creates virtual CoreMIDI ports that djay Pro sees as controllers.
//
// Usage: djay-midi-bridge "<port name>" ["<port name>" ...]
// For each name it creates a virtual source (we -> djay) and a virtual
// destination (djay -> we, used for LED/state feedback).
//
// stdin  (one JSON object per line):
//   {"op":"send","port":"djay MCP Global","bytes":[144,1,127]}
//   {"op":"add","port":"name"} / {"op":"remove","port":"name"}  (runtime port changes)
//   {"op":"list"}            -> lists every MIDI endpoint on the system
//   {"op":"ping","id":1}
// stdout (one JSON object per line):
//   {"ev":"ready","ports":[...]}
//   {"ev":"midi","port":"...","bytes":[...]}
//   {"ev":"pong","id":1}
//   {"ev":"error","message":"..."}

import CoreMIDI
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let outLock = NSLock()
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    outLock.lock()
    print(line)
    outLock.unlock()
}

// Stable unique IDs so djay recognises the same device across restarts.
func stableID(_ name: String) -> Int32 {
    var h: UInt32 = 2166136261
    for b in name.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
    return Int32(bitPattern: h | 0x1000_0000) & 0x7FFF_FFFF
}

func endpointName(_ ref: MIDIEndpointRef) -> String {
    var s: Unmanaged<CFString>?
    if MIDIObjectGetStringProperty(ref, kMIDIPropertyDisplayName, &s) == noErr, let v = s?.takeRetainedValue() {
        return v as String
    }
    if MIDIObjectGetStringProperty(ref, kMIDIPropertyName, &s) == noErr, let v = s?.takeRetainedValue() {
        return v as String
    }
    return "?"
}

// Ports named on the command line are created at startup; more can be added with {"op":"add"}.
let names = Array(CommandLine.arguments.dropFirst())

var client = MIDIClientRef()
var status = MIDIClientCreateWithBlock("djay MCP" as CFString, &client) { _ in }
guard status == noErr else {
    emit(["ev": "error", "message": "MIDIClientCreate failed: \(status)"])
    exit(1)
}

var sources: [String: MIDIEndpointRef] = [:]
var destinations: [String: MIDIEndpointRef] = [:]

func handleIncoming(_ portName: String, _ eventList: UnsafePointer<MIDIEventList>) {
    // Unpack MIDI 1.0 UMP words back into classic byte messages.
    var bytes: [Int] = []
    for packet in eventList.unsafeSequence() {
        let words = MIDIEventPacket.WordCollection(packet)
        for w in words {
            let type = (w >> 28) & 0xF
            if type == 0x2 { // MIDI 1.0 channel voice
                let st = Int((w >> 16) & 0xFF), d1 = Int((w >> 8) & 0x7F), d2 = Int(w & 0x7F)
                let kind = st & 0xF0
                if kind == 0xC0 || kind == 0xD0 { bytes += [st, d1] } else { bytes += [st, d1, d2] }
            } else if type == 0x1 { // system real-time / common (clock, start, stop)
                bytes.append(Int((w >> 16) & 0xFF))
            }
        }
    }
    if !bytes.isEmpty { emit(["ev": "midi", "port": portName, "bytes": bytes]) }
}

let setProps = ProcessInfo.processInfo.environment["DJAY_MCP_PORT_PROPS"] == "1"

/// Creates one virtual source + destination pair with the same name.
func addPort(_ name: String) -> String? {
    if sources[name] != nil { return nil }
    var src = MIDIEndpointRef()
    var st = MIDISourceCreateWithProtocol(client, name as CFString, ._1_0, &src)
    guard st == noErr else { return "MIDISourceCreate(\(name)) failed: \(st)" }
    MIDIObjectSetIntegerProperty(src, kMIDIPropertyUniqueID, stableID(name + "/src"))
    if setProps {
        MIDIObjectSetStringProperty(src, kMIDIPropertyManufacturer, "djay MCP" as CFString)
        MIDIObjectSetStringProperty(src, kMIDIPropertyModel, name as CFString)
    }
    sources[name] = src

    var dst = MIDIEndpointRef()
    st = MIDIDestinationCreateWithProtocol(client, name as CFString, ._1_0, &dst) { list, _ in handleIncoming(name, list) }
    guard st == noErr else { return "MIDIDestinationCreate(\(name)) failed: \(st)" }
    MIDIObjectSetIntegerProperty(dst, kMIDIPropertyUniqueID, stableID(name + "/dst"))
    if setProps {
        MIDIObjectSetStringProperty(dst, kMIDIPropertyManufacturer, "djay MCP" as CFString)
        MIDIObjectSetStringProperty(dst, kMIDIPropertyModel, name as CFString)
    }
    destinations[name] = dst
    return nil
}

func removePort(_ name: String) {
    if let s = sources.removeValue(forKey: name) { MIDIEndpointDispose(s) }
    if let d = destinations.removeValue(forKey: name) { MIDIEndpointDispose(d) }
}

for name in names {
    if let err = addPort(name) {
        emit(["ev": "error", "message": err])
        exit(1)
    }
}

func send(port: String, bytes: [UInt8]) -> Bool {
    guard let src = sources[port] else { return false }
    var i = 0
    var words: [UInt32] = []
    while i < bytes.count {
        let st = bytes[i]
        if st < 0x80 { i += 1; continue }
        let kind = st & 0xF0
        if st >= 0xF8 { // real-time
            words.append(0x1000_0000 | (UInt32(st) << 16)); i += 1; continue
        }
        let len = (kind == 0xC0 || kind == 0xD0) ? 2 : 3
        if i + len > bytes.count { break }
        let d1 = UInt32(bytes[i + 1] & 0x7F)
        let d2 = len == 3 ? UInt32(bytes[i + 2] & 0x7F) : 0
        words.append(0x2000_0000 | (UInt32(st) << 16) | (d1 << 8) | d2)
        i += len
    }
    if words.isEmpty { return true }
    var list = MIDIEventList()
    var pkt = MIDIEventListInit(&list, ._1_0)
    for w in words {
        var word = w
        pkt = MIDIEventListAdd(&list, MemoryLayout<MIDIEventList>.size, pkt, 0, 1, &word)
    }
    return MIDIReceivedEventList(src, &list) == noErr
}

func listEndpoints() -> [String: [String]] {
    var srcs: [String] = [], dsts: [String] = []
    for i in 0..<MIDIGetNumberOfSources() { srcs.append(endpointName(MIDIGetSource(i))) }
    for i in 0..<MIDIGetNumberOfDestinations() { dsts.append(endpointName(MIDIGetDestination(i))) }
    return ["sources": srcs, "destinations": dsts]
}

emit(["ev": "ready", "ports": Array(sources.keys)])

DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let op = msg["op"] as? String else {
            emit(["ev": "error", "message": "bad input line"])
            continue
        }
        switch op {
        case "send":
            let port = msg["port"] as? String ?? ""
            let raw = (msg["bytes"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.intValue }
            if !send(port: port, bytes: raw.map { UInt8(clamping: $0) }) {
                emit(["ev": "error", "message": "send failed on port \(port)"])
            }
        case "add":
            let port = msg["port"] as? String ?? ""
            if let err = addPort(port) { emit(["ev": "error", "message": err]) }
            else { emit(["ev": "added", "port": port]) }
        case "remove":
            let port = msg["port"] as? String ?? ""
            removePort(port)
            emit(["ev": "removed", "port": port])
        case "list":
            emit(["ev": "endpoints", "endpoints": listEndpoints()])
        case "ping":
            emit(["ev": "pong", "id": msg["id"] ?? NSNull()])
        default:
            emit(["ev": "error", "message": "unknown op \(op)"])
        }
    }
    exit(0) // stdin closed: parent went away
}

RunLoop.main.run()
