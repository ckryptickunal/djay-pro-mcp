#!/bin/sh
# Compiles the Swift helpers into ./bin (needs Xcode command line tools).
set -e
cd "$(dirname "$0")/.."
mkdir -p bin
swiftc -O -o bin/djay-midi-bridge bridge/MidiBridge.swift -framework CoreMIDI
swiftc -O -o bin/djay-ax-bridge bridge/AXBridge.swift
swiftc -O -o bin/djay-windows bridge/WindowShot.swift
echo "bridges built in $(pwd)/bin"
