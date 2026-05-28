#!/usr/bin/env swift
import AppKit

// Composites each provided screenshot onto a 2000×1250 Raycast-purple gradient
// canvas with a soft drop shadow. Outputs go alongside as PNG.
//
// Usage:
//   swift scripts/make-screenshots.swift \
//     <out-1.png>=<src-1.png> <out-2.png>=<src-2.png> ...

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write(Data("usage: make-screenshots.swift <out>=<src> [<out>=<src> ...]\n".utf8))
    exit(2)
}

let canvasW: CGFloat = 2000
let canvasH: CGFloat = 1250

func loadImage(at path: String) -> NSImage? {
    let url = URL(fileURLWithPath: path)
    guard let data = try? Data(contentsOf: url) else { return nil }
    return NSImage(data: data)
}

for arg in CommandLine.arguments.dropFirst() {
    let parts = arg.split(separator: "=", maxSplits: 1).map(String.init)
    guard parts.count == 2 else {
        FileHandle.standardError.write(Data("bad arg: \(arg)\n".utf8))
        continue
    }
    let outPath = parts[0]
    let srcPath = parts[1]

    guard let src = loadImage(at: srcPath) else {
        FileHandle.standardError.write(Data("could not read \(srcPath)\n".utf8))
        continue
    }
    let srcSize = src.size

    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(canvasW), pixelsHigh: Int(canvasH),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 32
    ) else { fatalError("rep") }
    rep.size = NSSize(width: canvasW, height: canvasH)

    guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { fatalError("ctx") }
    let prev = NSGraphicsContext.current
    NSGraphicsContext.current = ctx
    ctx.imageInterpolation = .high

    // 1. Raycast-style purple gradient backdrop.
    let topColor = NSColor(red: 0.20, green: 0.15, blue: 0.40, alpha: 1.0)
    let bottomColor = NSColor(red: 0.36, green: 0.27, blue: 0.78, alpha: 1.0)
    let gradient = NSGradient(starting: topColor, ending: bottomColor)!
    gradient.draw(in: NSRect(x: 0, y: 0, width: canvasW, height: canvasH), angle: 90)

    // 2. Compute the screenshot rect — fit inside an inset frame, preserving
    //    aspect ratio. Centered.
    let marginX: CGFloat = 200
    let marginY: CGFloat = 125
    let maxW = canvasW - marginX * 2
    let maxH = canvasH - marginY * 2
    let srcAspect = srcSize.width / srcSize.height
    var drawW = maxW
    var drawH = drawW / srcAspect
    if drawH > maxH {
        drawH = maxH
        drawW = drawH * srcAspect
    }
    let drawRect = NSRect(
        x: (canvasW - drawW) / 2,
        y: (canvasH - drawH) / 2,
        width: drawW,
        height: drawH
    )

    // 3. Soft drop shadow under the window.
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(white: 0, alpha: 0.45)
    shadow.shadowOffset = NSSize(width: 0, height: -12)
    shadow.shadowBlurRadius = 60
    shadow.set()

    // 4. Composite the screenshot. The source already has rounded corners
    //    baked in; draw as-is.
    src.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)

    NSGraphicsContext.current = prev

    guard let png = rep.representation(using: .png, properties: [:]) else {
        fatalError("png encode")
    }
    let outURL = URL(fileURLWithPath: outPath)
    try? FileManager.default.createDirectory(
        at: outURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try png.write(to: outURL)
    print("✓ \(outPath) (\(Int(canvasW))×\(Int(canvasH)))")
}
