// WBS-099: turns the square source artwork into a macOS-style app icon.
//
// The source (yolo-univ-icon-source.png) is an ivory rounded tile on an opaque
// white square, so the Dock showed a white square. This keeps the artwork and
// redraws it on Apple's macOS icon grid:
//   - 1024×1024 transparent canvas
//   - 824×824 body centred (100 px margin), continuous-curvature corners
//   - a soft drop shadow inside the margin, like other Mac apps
// The navy/gold glyphs are lifted off the ivory background (colour-to-alpha),
// scaled to keep a safe margin inside the body and drawn on a flat ivory tile.
//
// Usage: swift make-macos-icon.swift <source.png> <out-1024.png>
// Uses only CoreGraphics/ImageIO from macOS; nothing is installed.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3 else { fatalError("usage: make-macos-icon.swift <source.png> <out.png>") }

// Apple macOS icon grid (Big Sur and later), in 1024-canvas pixels.
let canvas = 1024
let body: CGFloat = 824
let bodyOrigin = (CGFloat(canvas) - body) / 2
let artworkShare: CGFloat = 0.78 // glyph block's longest side, as a share of the body

func rgba(_ image: CGImage) -> (data: [UInt8], width: Int, height: Int) {
  let width = image.width, height = image.height
  var data = [UInt8](repeating: 0, count: width * height * 4)
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  data.withUnsafeMutableBytes { buffer in
    let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                            space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  }
  return (data, width, height)
}

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let original = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fatalError("cannot read \(args[1])") }
var (pixels, width, height) = rgba(original)

// Ivory tile colour: median of a strip just inside the old tile's left edge (rows are top-down).
func pixel(_ x: Int, _ y: Int) -> (Int, Int, Int) { let i = (y * width + x) * 4; return (Int(pixels[i]), Int(pixels[i + 1]), Int(pixels[i + 2])) }
var strip: [(Int, Int, Int)] = []
for y in stride(from: height * 2 / 5, to: height * 3 / 5, by: 4) { strip.append(pixel(width / 12, y)) }
let ivory = (strip.map { $0.0 }.sorted()[strip.count / 2], strip.map { $0.1 }.sorted()[strip.count / 2], strip.map { $0.2 }.sorted()[strip.count / 2])

// The old tile's antialiased outline is not artwork: only count glyphs well inside the old tile.
var tileMinX = width, tileMinY = height, tileMaxX = 0, tileMaxY = 0
for y in 0..<height { for x in 0..<width { let p = pixel(x, y); if min(p.0, p.1, p.2) < 248 { tileMinX = min(tileMinX, x); tileMaxX = max(tileMaxX, x); tileMinY = min(tileMinY, y); tileMaxY = max(tileMaxY, y) } } }
let inset = width / 25
let inner = (tileMinX + inset)...(tileMaxX - inset), innerY = (tileMinY + inset)...(tileMaxY - inset)

// Colour-to-alpha against the ivory: the background becomes transparent, glyph edges keep their antialiasing.
// Only glyph pixels (clearly darker or more saturated than ivory) count towards the artwork bounds.
var minX = width, minY = height, maxX = 0, maxY = 0
for y in 0..<height {
  for x in 0..<width {
    let i = (y * width + x) * 4
    let p = [Int(pixels[i]), Int(pixels[i + 1]), Int(pixels[i + 2])], b = [ivory.0, ivory.1, ivory.2]
    var alpha = 0.0
    for c in 0..<3 {
      let d = Double(p[c] - b[c])
      alpha = max(alpha, d > 0 ? d / Double(255 - b[c] == 0 ? 1 : 255 - b[c]) : -d / Double(max(b[c], 1)))
    }
    // White outside the old tile is lighter than ivory; it is background too.
    if p[0] >= b[0] && p[1] >= b[1] && p[2] >= b[2] { alpha = 0 }
    alpha = min(1, alpha)
    if alpha < 0.04 { pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 0; continue }
    for c in 0..<3 {
      let value = (Double(p[c]) - Double(b[c])) / alpha + Double(b[c])
      pixels[i + c] = UInt8(max(0, min(255, (value * alpha).rounded()))) // premultiplied
    }
    pixels[i + 3] = UInt8((alpha * 255).rounded())
    if alpha > 0.5 && inner.contains(x) && innerY.contains(y) { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) }
  }
}
guard maxX > minX, maxY > minY else { fatalError("no artwork found") }

let space = CGColorSpace(name: CGColorSpace.sRGB)!
let glyphs: CGImage = pixels.withUnsafeMutableBytes { buffer in
  let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  return context.makeImage()!.cropping(to: CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))!
}

// Continuous-curvature body: a superellipse (n = 5), the usual stand-in for Apple's squircle.
func squircle(_ rect: CGRect, exponent n: CGFloat = 5, steps: Int = 720) -> CGPath {
  let path = CGMutablePath()
  let (cx, cy, a, b) = (rect.midX, rect.midY, rect.width / 2, rect.height / 2)
  for step in 0..<steps {
    let t = CGFloat(step) / CGFloat(steps) * 2 * .pi
    let (c, s) = (cos(t), sin(t))
    let point = CGPoint(x: cx + a * (c < 0 ? -1 : 1) * pow(abs(c), 2 / n), y: cy + b * (s < 0 ? -1 : 1) * pow(abs(s), 2 / n))
    step == 0 ? path.move(to: point) : path.addLine(to: point)
  }
  path.closeSubpath()
  return path
}

let context = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: canvas * 4, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.setShouldAntialias(true)
context.interpolationQuality = .high
let tile = CGRect(x: bodyOrigin, y: bodyOrigin, width: body, height: body)
let shape = squircle(tile)
let fill = CGColor(srgbRed: CGFloat(ivory.0) / 255, green: CGFloat(ivory.1) / 255, blue: CGFloat(ivory.2) / 255, alpha: 1)

// Soft shadow below the tile (CoreGraphics y points up), kept inside the 100 px margin.
context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.30))
context.addPath(shape); context.setFillColor(fill); context.fillPath()
context.restoreGState()
// A hairline edge so the light tile still reads on light backgrounds.
context.addPath(shape); context.setStrokeColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.08)); context.setLineWidth(2); context.strokePath()

// Glyphs, centred in the body with the same aspect ratio.
let scale = body * artworkShare / CGFloat(max(glyphs.width, glyphs.height))
let size = CGSize(width: CGFloat(glyphs.width) * scale, height: CGFloat(glyphs.height) * scale)
context.saveGState()
context.addPath(shape); context.clip()
context.draw(glyphs, in: CGRect(x: tile.midX - size.width / 2, y: tile.midY - size.height / 2, width: size.width, height: size.height))
context.restoreGState()

let out = URL(fileURLWithPath: args[2]) as CFURL
guard let destination = CGImageDestinationCreateWithURL(out, UTType.png.identifier as CFString, 1, nil) else { fatalError("cannot write \(args[2])") }
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("cannot write \(args[2])") }
print("ivory \(ivory), artwork \(maxX - minX + 1)×\(maxY - minY + 1) → \(Int(size.width))×\(Int(size.height)) in \(Int(body)) body")
