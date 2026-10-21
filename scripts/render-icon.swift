// Renders build/icon.svg to a transparent 1024 px PNG: swift scripts/render-icon.swift in.svg out.png
import AppKit
let args = CommandLine.arguments
guard let svg = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else { fatalError("cannot load svg") }
let size = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.clear.set()
NSRect(x: 0, y: 0, width: size, height: size).fill()
svg.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
let c = rep.colorAt(x: 5, y: 5)!
print("corner alpha:", c.alphaComponent)
