#!/usr/bin/env swift
//
// Renders the tab bar's SF Symbols to PNG at a chosen point size.
//
// Why this exists: on iOS the bar is a real UITabBarController (see
// app/(app)/_layout.tsx), and UIKit decides how large an `sf=` symbol is drawn
// — neither expo-router's NativeTabs nor react-native-screens exposes a size.
// Handing UIKit a raster image instead puts the size back under our control,
// because a tab bar item is drawn at its image's own point size. These are the
// same symbols the bar used to name directly, so the glyphs do not change.
//
// The symbols come from the system font, so this must run on macOS:
//
//   swift apps/mobile/scripts/render-tab-icons.swift
//
// Output is `assets/tabs/sf/<name>{,@2x,@3x}.png`, template art (black glyph on
// alpha) so UIKit tints it for the selected and unselected states.

import AppKit
import Foundation

/// Tab bar standard is 25pt; this is the "slightly smaller" the design asked for.
let POINT_SIZE: CGFloat = 18

let icons: [(symbol: String, name: String)] = [
  ("point.3.connected.trianglepath.dotted", "insight"),
  ("star", "watchlist"),
  ("star.fill", "watchlist-selected"),
  ("chart.pie", "portfolio"),
  ("chart.pie.fill", "portfolio-selected"),
  ("doc.text.magnifyingglass", "analysis"),
  ("sparkles", "agents"),
]

let outDir = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()          // scripts/
  .deletingLastPathComponent()          // apps/mobile/
  .appendingPathComponent("assets/tabs/sf")

try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

func write(_ image: NSImage, to url: URL, scale: CGFloat) throws {
  let pixels = NSSize(width: (image.size.width * scale).rounded(),
                      height: (image.size.height * scale).rounded())
  guard
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: Int(pixels.width),
      pixelsHigh: Int(pixels.height),
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0,
      bitsPerPixel: 0
    )
  else { throw NSError(domain: "render-tab-icons", code: 1) }

  rep.size = pixels
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSColor.black.set()
  image.draw(
    in: NSRect(origin: .zero, size: pixels),
    from: .zero,
    operation: .sourceOver,
    fraction: 1
  )
  NSGraphicsContext.restoreGraphicsState()

  guard let png = rep.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "render-tab-icons", code: 2)
  }
  try png.write(to: url)
}

let config = NSImage.SymbolConfiguration(pointSize: POINT_SIZE, weight: .regular)

for icon in icons {
  guard
    let base = NSImage(systemSymbolName: icon.symbol, accessibilityDescription: nil),
    let sized = base.withSymbolConfiguration(config)
  else {
    FileHandle.standardError.write("missing SF Symbol: \(icon.symbol)\n".data(using: .utf8)!)
    exit(1)
  }

  for scale in [1, 2, 3] {
    let suffix = scale == 1 ? "" : "@\(scale)x"
    let url = outDir.appendingPathComponent("\(icon.name)\(suffix).png")
    try write(sized, to: url, scale: CGFloat(scale))
  }
  print(String(format: "%@  %.0f x %.0f pt", icon.name, sized.size.width, sized.size.height))
}
