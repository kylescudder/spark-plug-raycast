#!/usr/bin/env swift
import AppKit

// Composites each provided screenshot onto a 2000×1250 Raycast-purple gradient
// canvas. Auto-detects the actual Raycast window inside the source PNG by
// scanning from each edge inward for the first row/column whose pixels differ
// from the corner sample (assumed to be desktop wallpaper). Applies a rounded-
// corner clip when drawing so any residual corner pixels are hidden.
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

func loadBitmap(at path: String) -> NSBitmapImageRep? {
    let url = URL(fileURLWithPath: path)
    guard let data = try? Data(contentsOf: url),
          let rep = NSBitmapImageRep(data: data) else { return nil }
    return rep
}

/// Detects the bounding box of the Raycast window inside the source bitmap by
/// scanning for the first non-wallpaper pixel from each edge. Returns the rect
/// in pixel coordinates of the source.
func detectWindowRect(_ rep: NSBitmapImageRep) -> NSRect {
    let w = rep.pixelsWide
    let h = rep.pixelsHigh

    // Sample wallpaper from a few corner pixels and take the mean as the
    // reference colour. We pick (4,4) etc to avoid any anti-aliasing at the
    // outermost edge.
    let samples = [(4, 4), (w - 5, 4), (4, h - 5), (w - 5, h - 5)]
    var rSum = 0.0, gSum = 0.0, bSum = 0.0
    for (sx, sy) in samples {
        if let c = rep.colorAt(x: sx, y: sy) {
            rSum += c.redComponent
            gSum += c.greenComponent
            bSum += c.blueComponent
        }
    }
    let refR = CGFloat(rSum / Double(samples.count))
    let refG = CGFloat(gSum / Double(samples.count))
    let refB = CGFloat(bSum / Double(samples.count))

    func differs(_ x: Int, _ y: Int) -> Bool {
        guard let c = rep.colorAt(x: x, y: y) else { return false }
        let d = abs(c.redComponent - refR)
              + abs(c.greenComponent - refG)
              + abs(c.blueComponent - refB)
        // Tight threshold: Raycast's translucent edge blends with the wallpaper,
        // so we only count clearly darker (interior) pixels as "window". This
        // crops through the glass halo to the solid content area.
        return d > 0.55
    }

    // From each edge, find the first row/column with a streak of non-wallpaper
    // pixels (avoids being fooled by isolated outliers like cursor glints).
    let streak = 16

    var left = 0
    for x in 0..<(w / 2) {
        var hits = 0
        for y in 0..<h {
            if differs(x, y) { hits += 1; if hits >= streak { break } } else { hits = 0 }
        }
        if hits >= streak { left = x; break }
    }
    var right = w
    for x in stride(from: w - 1, through: w / 2, by: -1) {
        var hits = 0
        for y in 0..<h {
            if differs(x, y) { hits += 1; if hits >= streak { break } } else { hits = 0 }
        }
        if hits >= streak { right = x + 1; break }
    }
    var top = 0
    for y in 0..<(h / 2) {
        var hits = 0
        for x in 0..<w {
            if differs(x, y) { hits += 1; if hits >= streak { break } } else { hits = 0 }
        }
        if hits >= streak { top = y; break }
    }
    var bottom = h
    for y in stride(from: h - 1, through: h / 2, by: -1) {
        var hits = 0
        for x in 0..<w {
            if differs(x, y) { hits += 1; if hits >= streak { break } } else { hits = 0 }
        }
        if hits >= streak { bottom = y + 1; break }
    }

    // Sanity guard — if detection found nothing, return full rect.
    if right - left < 100 || bottom - top < 100 {
        return NSRect(x: 0, y: 0, width: w, height: h)
    }
    // Push outward a few pixels to keep the rounded corners (we re-apply our
    // own rounded clip when drawing) while still excluding the glass halo.
    let pad = -4
    let l = max(0, left + pad)
    let r = min(w, right - pad)
    let t = max(0, top + pad)
    let b = min(h, bottom - pad)
    return NSRect(x: l, y: t, width: r - l, height: b - t)
}

for arg in CommandLine.arguments.dropFirst() {
    let parts = arg.split(separator: "=", maxSplits: 1).map(String.init)
    guard parts.count == 2 else {
        FileHandle.standardError.write(Data("bad arg: \(arg)\n".utf8))
        continue
    }
    let outPath = parts[0]
    let srcPath = parts[1]

    guard let srcRep = loadBitmap(at: srcPath) else {
        FileHandle.standardError.write(Data("could not read \(srcPath)\n".utf8))
        continue
    }
    let srcW = srcRep.pixelsWide
    let srcH = srcRep.pixelsHigh

    // colorAt indexes pixels with origin at top-left. Convert to bottom-up
    // for drawing rect.
    let cropPx = detectWindowRect(srcRep)
    let cropFlipped = NSRect(
        x: cropPx.minX,
        y: CGFloat(srcH) - cropPx.maxY,
        width: cropPx.width,
        height: cropPx.height
    )

    // Crop the source by drawing it offset into a fresh image at the crop size.
    let cropped = NSImage(size: NSSize(width: cropPx.width, height: cropPx.height))
    cropped.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    let srcImg = NSImage(size: NSSize(width: srcW, height: srcH))
    srcImg.addRepresentation(srcRep)
    srcImg.draw(
        in: NSRect(origin: .zero, size: cropped.size),
        from: cropFlipped,
        operation: .copy,
        fraction: 1.0
    )
    cropped.unlockFocus()

    // Build the canvas.
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

    // Dark backdrop — keeps the Raycast window the visual focus and avoids
    // a "two-tone" clash with the window's own translucent purple glass.
    let topColor = NSColor(red: 0.06, green: 0.05, blue: 0.12, alpha: 1.0)
    let bottomColor = NSColor(red: 0.16, green: 0.12, blue: 0.28, alpha: 1.0)
    let gradient = NSGradient(starting: topColor, ending: bottomColor)!
    gradient.draw(in: NSRect(x: 0, y: 0, width: canvasW, height: canvasH), angle: 90)

    // Compute draw rect, preserving aspect ratio.
    let marginX: CGFloat = 200
    let marginY: CGFloat = 125
    let maxW = canvasW - marginX * 2
    let maxH = canvasH - marginY * 2
    let srcAspect = cropped.size.width / cropped.size.height
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

    // Soft drop shadow under the window.
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(white: 0, alpha: 0.45)
    shadow.shadowOffset = NSSize(width: 0, height: -12)
    shadow.shadowBlurRadius = 60
    shadow.set()

    // Rounded-corner clip so any residual wallpaper at the crop corners is hidden.
    let cornerRadius: CGFloat = 24
    let mask = NSBezierPath(roundedRect: drawRect, xRadius: cornerRadius, yRadius: cornerRadius)
    mask.addClip()

    cropped.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()

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
    print("✓ \(outPath) — cropped source to \(Int(cropPx.width))×\(Int(cropPx.height)) (was \(srcW)×\(srcH))")
}
