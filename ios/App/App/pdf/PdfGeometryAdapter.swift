import UIKit
import PDFKit
import PencilKit

public struct PdfNormalizedPoint {
    public let x: CGFloat
    public let y: CGFloat
    public let p: CGFloat?

    public init(x: CGFloat, y: CGFloat, p: CGFloat? = 1.0) {
        self.x = x
        self.y = y
        self.p = p
    }

    public var dictionary: [String: Any] {
        var dict: [String: Any] = ["x": Double(x), "y": Double(y)]
        if let p = p {
            dict["p"] = Double(p)
        }
        return dict
    }

    public static func from(dictionary: [String: Any]) -> PdfNormalizedPoint? {
        guard let x = dictionary["x"] as? Double,
              let y = dictionary["y"] as? Double else { return nil }
        let p = dictionary["p"] as? Double
        return PdfNormalizedPoint(x: CGFloat(x), y: CGFloat(y), p: p != nil ? CGFloat(p!) : 1.0)
    }
}

public struct PdfBridgeStroke {
    public let id: String
    public let page: Int
    public let tool: String
    public let color: String
    public let width: CGFloat
    public let opacity: CGFloat
    public let points: [PdfNormalizedPoint]
    public let createdAt: Int64

    public var dictionary: [String: Any] {
        [
            "id": id,
            "page": page,
            "tool": tool,
            "color": color,
            "width": Double(width),
            "opacity": Double(opacity),
            "points": points.map { $0.dictionary },
            "createdAt": createdAt
        ]
    }

    public static func from(dictionary: [String: Any]) -> PdfBridgeStroke? {
        guard let id = dictionary["id"] as? String,
              let page = dictionary["page"] as? Int,
              let ptsArray = dictionary["points"] as? [[String: Any]] else {
            return nil
        }

        let tool = dictionary["tool"] as? String ?? "pencil"
        let color = dictionary["color"] as? String ?? "#4f46e5"
        let width = CGFloat(dictionary["width"] as? Double ?? 4.0)
        let opacity = CGFloat(dictionary["opacity"] as? Double ?? 1.0)
        let createdAt = Int64(dictionary["createdAt"] as? Double ?? Double(Date().timeIntervalSince1970 * 1000))
        let points = ptsArray.compactMap { PdfNormalizedPoint.from(dictionary: $0) }

        return PdfBridgeStroke(
            id: id,
            page: page,
            tool: tool,
            color: color,
            width: width,
            opacity: opacity,
            points: points,
            createdAt: createdAt
        )
    }
}

public enum PdfGeometryAdapter {

    /// Converts normalized point [0..1] on a PDFPage cropBox into UIKit view coordinates
    public static func normalizedToViewPoint(
        normalized: PdfNormalizedPoint,
        pageBounds: CGRect
    ) -> CGPoint {
        CGPoint(
            x: pageBounds.origin.x + normalized.x * pageBounds.width,
            y: pageBounds.origin.y + normalized.y * pageBounds.height
        )
    }

    /// Converts view point into normalized coordinates [0..1] within the PDFPage cropBox
    public static func viewToNormalizedPoint(
        point: CGPoint,
        pageBounds: CGRect,
        pressure: CGFloat = 1.0
    ) -> PdfNormalizedPoint {
        let clampedX = max(0, min(1, (point.x - pageBounds.origin.x) / max(1, pageBounds.width)))
        let clampedY = max(0, min(1, (point.y - pageBounds.origin.y) / max(1, pageBounds.height)))
        return PdfNormalizedPoint(x: clampedX, y: clampedY, p: pressure)
    }

    /// Converts PencilKit PKStroke into a normalized PdfBridgeStroke
    public static func strokeFromPencilKit(
        pkStroke: PKStroke,
        pageIndex: Int,
        tool: String,
        colorHex: String,
        strokeWidth: CGFloat,
        pageBounds: CGRect
    ) -> PdfBridgeStroke {
        var points: [PdfNormalizedPoint] = []
        let path = pkStroke.path
        let count = path.count

        for i in 0..<count {
            let point = path[i]
            let normalized = viewToNormalizedPoint(
                point: point.location,
                pageBounds: pageBounds,
                pressure: point.force
            )
            points.append(normalized)
        }

        return PdfBridgeStroke(
            id: UUID().uuidString,
            page: pageIndex,
            tool: tool,
            color: colorHex,
            width: strokeWidth,
            opacity: tool == "free_highlighter" ? 0.38 : 1.0,
            points: points,
            createdAt: Int64(Date().timeIntervalSince1970 * 1000)
        )
    }

    public static func colorFromHex(_ hex: String) -> UIColor {
        var clean = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.hasPrefix("#") { clean.removeFirst() }
        guard let intVal = UInt64(clean, radix: 16) else { return .black }

        if clean.count == 6 {
            let r = CGFloat((intVal >> 16) & 0xFF) / 255.0
            let g = CGFloat((intVal >> 8) & 0xFF) / 255.0
            let b = CGFloat(intVal & 0xFF) / 255.0
            return UIColor(red: r, green: g, blue: b, alpha: 1.0)
        }
        return .black
    }
}
