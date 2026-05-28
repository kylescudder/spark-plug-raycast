#!/usr/bin/env swift
import AppKit

// Trims the uniform border around a Raycast screenshot (whatever colour it is —
// inferred from the corner pixel) and composites the result onto a 2000×1250
// dark gradient with a rounded clip + soft drop shadow.
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

struct FastBitmap {
    let buf: [UInt8]
    let width: Int
    let height: Int

    init?(_ rep: NSBitmapImageRep) {
        let w = rep.pixelsWide
        let h = rep.pixelsHigh
        let bpr = w * 4
        var buf = [UInt8](repeating: 0, count: bpr * h)
        let ok = buf.withUnsafeMutableBufferPointer { ptr -> Bool in
            guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
                  let cg = rep.cgImage,
                  let ctx = CGContext(
                    data: ptr.baseAddress,
                    width: w, height: h,
                    bitsPerComponent: 8, bytesPerRow: bpr,
                    space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                  )
            else { return false }
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return nil }
        self.buf = buf
        self.width = w
        self.height = h
    }

    /// (r, g, b) for the pixel at (x, y) with origin TOP-LEFT.
    @inline(__always)
    func rgb(_ x: Int, _ y: Int) -> (Double, Double, Double) {
        // CGContext stores rows bottom-up; flip y to map to a top-left origin.
        let row = height - 1 - y
        let o = row * width * 4 + x * 4
        return (
            Double(buf[o]) / 255.0,
            Double(buf[o + 1]) / 255.0,
            Double(buf[o + 2]) / 255.0
        )
    }
}

/// Trims a uniform border. Samples the four corners to find the border colour,
/// then scans each edge inward to find the first row/column whose pixels
/// (mostly) differ from it. Returns the inner content rect.
func trimUniformBorder(_ bmp: FastBitmap) -> NSRect {
    let w = bmp.width
    let h = bmp.height

    // Average the corner samples for the reference colour.
    let corners = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    var rs = 0.0, gs = 0.0, bs = 0.0
    for (x, y) in corners {
        let (r, g, b) = bmp.rgb(x, y)
        rs += r; gs += g; bs += b
    }
    let refR = rs / 4, refG = gs / 4, refB = bs / 4

    @inline(__always)
    func differs(_ x: Int, _ y: Int) -> Bool {
        let (r, g, b) = bmp.rgb(x, y)
        return abs(r - refR) + abs(g - refG) + abs(b - refB) > 0.10
    }

    func rowHasContent(_ y: Int) -> Bool {
        var hits = 0
        for x in 0..<w {
            if differs(x, y) {
                hits += 1
                if hits >= 24 { return true }
            } else {
                hits = 0
            }
        }
        return false
    }
    func colHasContent(_ x: Int) -> Bool {
        var hits = 0
        for y in 0..<h {
            if differs(x, y) {
                hits += 1
                if hits >= 24 { return true }
            } else {
                hits = 0
            }
        }
        return false
    }

    var top = 0
    for y in 0..<h { if rowHasContent(y) { top = y; break } }
    var bottom = h - 1
    for y in stride(from: h - 1, through: 0, by: -1) { if rowHasContent(y) { bottom = y; break } }
    var left = 0
    for x in 0..<w { if colHasContent(x) { left = x; break } }
    var right = w - 1
    for x in stride(from: w - 1, through: 0, by: -1) { if colHasContent(x) { right = x; break } }

    return NSRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
}

for arg in CommandLine.arguments.dropFirst() {
    let parts = arg.split(separator: "=", maxSplits: 1).map(String.init)
    guard parts.count == 2 else {
        FileHandle.standardError.write(Data("bad arg: \(arg)\n".utf8))
        continue
    }
    let outPath = parts[0]
    let srcPath = parts[1]

    guard let srcRep = NSBitmapImageRep(data: (try? Data(contentsOf: URL(fileURLWithPath: srcPath))) ?? Data()) else {
        FileHandle.standardError.write(Data("could not read \(srcPath)\n".utf8))
        continue
    }
    let srcW = srcRep.pixelsWide
    let srcH = srcRep.pixelsHigh

    guard let bmp = FastBitmap(srcRep) else {
        FileHandle.standardError.write(Data("could not access bitmap data for \(srcPath)\n".utf8))
        continue
    }

    let cropPx = trimUniformBorder(bmp)
    let cropFlipped = NSRect(
        x: cropPx.minX,
        y: CGFloat(srcH) - cropPx.maxY,
        width: cropPx.width,
        height: cropPx.height
    )

    // Crop the source into a fresh image at the crop size.
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
    guard let outRep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(canvasW), pixelsHigh: Int(canvasH),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 32
    ) else { fatalError("rep") }
    outRep.size = NSSize(width: canvasW, height: canvasH)

    guard let ctx = NSGraphicsContext(bitmapImageRep: outRep) else { fatalError("ctx") }
    let prev = NSGraphicsContext.current
    NSGraphicsContext.current = ctx
    ctx.imageInterpolation = .high

    // Dark gradient backdrop.
    let topColor = NSColor(red: 0.06, green: 0.05, blue: 0.12, alpha: 1.0)
    let bottomColor = NSColor(red: 0.16, green: 0.12, blue: 0.28, alpha: 1.0)
    let gradient = NSGradient(starting: topColor, ending: bottomColor)!
    gradient.draw(in: NSRect(x: 0, y: 0, width: canvasW, height: canvasH), angle: 90)

    // Compute draw rect preserving aspect ratio.
    let marginX: CGFloat = 200
    let marginY: CGFloat = 125
    let maxW = canvasW - marginX * 2
    let maxH = canvasH - marginY * 2
    let aspect = cropped.size.width / cropped.size.height
    var drawW = maxW
    var drawH = drawW / aspect
    if drawH > maxH {
        drawH = maxH
        drawW = drawH * aspect
    }
    let drawRect = NSRect(
        x: (canvasW - drawW) / 2,
        y: (canvasH - drawH) / 2,
        width: drawW,
        height: drawH
    )

    // Drop shadow + rounded clip.
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(white: 0, alpha: 0.5)
    shadow.shadowOffset = NSSize(width: 0, height: -14)
    shadow.shadowBlurRadius = 60
    shadow.set()
    NSBezierPath(roundedRect: drawRect, xRadius: 28, yRadius: 28).addClip()
    cropped.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()

    NSGraphicsContext.current = prev

    guard let png = outRep.representation(using: .png, properties: [:]) else {
        fatalError("png encode")
    }
    let outURL = URL(fileURLWithPath: outPath)
    try? FileManager.default.createDirectory(
        at: outURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try png.write(to: outURL)
    print("✓ \(outPath) — trimmed to \(Int(cropPx.width))×\(Int(cropPx.height)) from \(srcW)×\(srcH)")
}
