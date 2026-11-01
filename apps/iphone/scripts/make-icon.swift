// Draws the app icon (1024 x 1024 PNG) with CoreGraphics: a void plate, a cyan dimmer ring with a
// volt value arc, and a chamfered keyline frame. No external assets.
//   swift apps/iphone/scripts/make-icon.swift apps/iphone/ControlEverything/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
import AppKit
import CoreGraphics
import Foundation

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"
let size = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fatalError("no context") }

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}
let void = rgb(0x0A0E12), plate = rgb(0x101820), cyan = rgb(0x38F0FF), volt = rgb(0xEEFF41)
let s = CGFloat(size)

// background
ctx.setFillColor(void)
ctx.fill(CGRect(x: 0, y: 0, width: s, height: s))

// faint scanlines
ctx.setFillColor(rgb(0x38F0FF, 0.035))
var y: CGFloat = 0
while y < s { ctx.fill(CGRect(x: 0, y: y, width: s, height: 3)); y += 12 }

// chamfered plate
let inset: CGFloat = 120, cut: CGFloat = 90
let r = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
let p = CGMutablePath()
p.move(to: CGPoint(x: r.minX + cut, y: r.minY))
p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - cut))
p.addLine(to: CGPoint(x: r.maxX - cut, y: r.maxY))
p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
p.addLine(to: CGPoint(x: r.minX, y: r.minY + cut))
p.closeSubpath()
ctx.addPath(p); ctx.setFillColor(plate); ctx.fillPath()
ctx.addPath(p); ctx.setStrokeColor(void); ctx.setLineWidth(22); ctx.strokePath()
ctx.addPath(p); ctx.setStrokeColor(rgb(0x38F0FF, 0.75)); ctx.setLineWidth(9); ctx.strokePath()

// dimmer ring: void keyline under a cyan track, then a volt value arc
let c = CGPoint(x: s / 2, y: s / 2)
let radius: CGFloat = 250
let start = CGFloat.pi * 1.25, end = -CGFloat.pi * 0.25 // 270 degree sweep, gap at the bottom
func arc(_ from: CGFloat, _ to: CGFloat, _ width: CGFloat, _ color: CGColor) {
    ctx.beginPath()
    ctx.addArc(center: c, radius: radius, startAngle: from, endAngle: to, clockwise: true)
    ctx.setLineCap(.butt); ctx.setLineWidth(width); ctx.setStrokeColor(color); ctx.strokePath()
}
arc(start, end, 86, void)
arc(start, end, 52, rgb(0x38F0FF, 0.28))
let valueEnd = start - (start - end) * 0.68
arc(start, valueEnd, 86, void)
arc(start, valueEnd, 52, volt)

// knob face + pointer
ctx.setFillColor(rgb(0x0C2630))
ctx.fillEllipse(in: CGRect(x: c.x - 150, y: c.y - 150, width: 300, height: 300))
ctx.setStrokeColor(cyan); ctx.setLineWidth(10)
ctx.strokeEllipse(in: CGRect(x: c.x - 150, y: c.y - 150, width: 300, height: 300))
let ang = valueEnd
ctx.setStrokeColor(volt); ctx.setLineWidth(26); ctx.setLineCap(.round)
ctx.move(to: CGPoint(x: c.x + cos(ang) * 40, y: c.y + sin(ang) * 40))
ctx.addLine(to: CGPoint(x: c.x + cos(ang) * 118, y: c.y + sin(ang) * 118))
ctx.strokePath()

guard let img = ctx.makeImage() else { fatalError("no image") }
let rep = NSBitmapImageRep(cgImage: img)
guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("no png") }
try data.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
