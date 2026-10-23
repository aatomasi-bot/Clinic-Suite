// Reads the text of a scanned PDF (or image) with macOS's built-in text
// recognition (Vision — the same engine as Live Text). Runs on this Mac only;
// nothing is sent anywhere.
//
//   ocr <file.pdf|file.jpg>  →  JSON on stdout:
//   {"pages":[{"page":1,"width":612,"height":792,"lines":[{"text":"3-m (22.5mg)","x":111,"y":681,"w":60,"h":10,"conf":0.98}, …]}]}
//
// Coordinates are PDF points with the origin at the bottom-left, like pdf.js.
import Foundation
import PDFKit
import Vision
import AppKit

struct Line: Encodable { let text: String; let x, y, w, h: Double; let conf: Float }
struct Page: Encodable { let page: Int; let width, height: Double; let lines: [Line] }
struct Out: Encodable { let pages: [Page] }

func recognize(_ cg: CGImage, width: Double, height: Double) throws -> [Line] {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false          // keep numbers and codes as written
  req.recognitionLanguages = ["en-US", "fr-FR"]
  try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  return (req.results ?? []).compactMap { obs in
    guard let best = obs.topCandidates(1).first else { return nil }
    let b = obs.boundingBox                    // normalized, origin bottom-left
    return Line(text: best.string, x: b.minX * width, y: b.minY * height, w: b.width * width, h: b.height * height, conf: best.confidence)
  }
}

func render(_ page: PDFPage, scale: CGFloat) -> CGImage? {
  let box = page.bounds(for: .mediaBox)
  let w = Int(box.width * scale), h = Int(box.height * scale)
  guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.scaleBy(x: scale, y: scale)
  ctx.translateBy(x: -box.minX, y: -box.minY)
  page.draw(with: .mediaBox, to: ctx)
  return ctx.makeImage()
}

let args = CommandLine.arguments
guard args.count == 2 else { FileHandle.standardError.write("usage: ocr <file.pdf|image>\n".data(using: .utf8)!); exit(2) }
let url = URL(fileURLWithPath: args[1])
var pages: [Page] = []
do {
  if let doc = PDFDocument(url: url) {
    for i in 0..<min(doc.pageCount, 6) {      // assignment forms are 1–2 pages
      guard let p = doc.page(at: i), let cg = render(p, scale: 3) else { continue }
      let box = p.bounds(for: .mediaBox)
      pages.append(Page(page: i + 1, width: box.width, height: box.height, lines: try recognize(cg, width: box.width, height: box.height)))
    }
  } else if let img = NSImage(contentsOf: url), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
    let w = Double(cg.width), h = Double(cg.height)
    pages.append(Page(page: 1, width: w, height: h, lines: try recognize(cg, width: w, height: h)))
  } else {
    FileHandle.standardError.write("cannot open file\n".data(using: .utf8)!); exit(1)
  }
  let data = try JSONEncoder().encode(Out(pages: pages))
  FileHandle.standardOutput.write(data)
} catch {
  FileHandle.standardError.write("ocr failed: \(error)\n".data(using: .utf8)!); exit(1)
}
