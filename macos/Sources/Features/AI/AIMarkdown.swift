import AppKit
import GlideUI
import SwiftUI

/// Block-level Markdown for AI answers (headings, paragraphs, lists, quotes, fenced code, rules). Inline
/// syntax (bold, italic, code, links) is rendered by `AttributedString(markdown:)`. Robust to a half-streamed
/// document: an unterminated fence renders as code so far.
public enum AIMarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case bullets([String])
    case numbered(start: Int, items: [String])
    case quote(String)
    case code(language: String?, text: String)
    case rule
}

public enum AIMarkdown {
    public static func parse(_ text: String) -> [AIMarkdownBlock] {
        var blocks: [AIMarkdownBlock] = []
        var para: [String] = []
        var bullets: [String] = []
        var numbered: [String] = []
        var numberedStart = 1
        var quote: [String] = []
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")

        func flush() {
            if !para.isEmpty { blocks.append(.paragraph(para.joined(separator: "\n"))); para = [] }
            if !bullets.isEmpty { blocks.append(.bullets(bullets)); bullets = [] }
            if !numbered.isEmpty { blocks.append(.numbered(start: numberedStart, items: numbered)); numbered = [] }
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))); quote = [] }
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let fence = String(trimmed.prefix(3))
                let lang = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    code.append(lines[i])
                    i += 1
                }
                blocks.append(.code(language: lang.isEmpty ? nil : lang, text: code.joined(separator: "\n")))
                i += 1
                continue
            }
            if trimmed.isEmpty { flush(); i += 1; continue }
            if let h = heading(trimmed) { flush(); blocks.append(h); i += 1; continue }
            if isRule(trimmed) { flush(); blocks.append(.rule); i += 1; continue }
            if let item = bulletItem(line) {
                if !numbered.isEmpty || !para.isEmpty || !quote.isEmpty { flush() }
                bullets.append(item)
                i += 1
                continue
            }
            if let (n, item) = numberedItem(line) {
                if !bullets.isEmpty || !para.isEmpty || !quote.isEmpty { flush() }
                if numbered.isEmpty { numberedStart = n }
                numbered.append(item)
                i += 1
                continue
            }
            if trimmed.hasPrefix(">") {
                if !bullets.isEmpty || !numbered.isEmpty || !para.isEmpty { flush() }
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                i += 1
                continue
            }
            // Lazy continuation of a list item.
            if line.hasPrefix("  "), !bullets.isEmpty { bullets[bullets.count - 1] += " " + trimmed; i += 1; continue }
            if line.hasPrefix("  "), !numbered.isEmpty { numbered[numbered.count - 1] += " " + trimmed; i += 1; continue }
            if !bullets.isEmpty || !numbered.isEmpty || !quote.isEmpty { flush() }
            para.append(trimmed)
            i += 1
        }
        flush()
        return blocks
    }

    static func heading(_ t: String) -> AIMarkdownBlock? {
        let hashes = t.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), t.count > hashes, t[t.index(t.startIndex, offsetBy: hashes)] == " " else { return nil }
        return .heading(level: hashes, text: t.dropFirst(hashes).trimmingCharacters(in: .whitespaces))
    }

    static func isRule(_ t: String) -> Bool {
        let s = t.replacingOccurrences(of: " ", with: "")
        return s.count >= 3 && (Set(s) == ["-"] || Set(s) == ["*"] || Set(s) == ["_"])
    }

    static func bulletItem(_ line: String) -> String? {
        let t = line.drop { $0 == " " }
        guard let f = t.first, "-*+".contains(f), t.dropFirst().first == " " else { return nil }
        return t.dropFirst(2).trimmingCharacters(in: .whitespaces)
    }

    static func numberedItem(_ line: String) -> (Int, String)? {
        let t = line.drop { $0 == " " }
        let digits = t.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count < 10, let n = Int(digits) else { return nil }
        let rest = t.dropFirst(digits.count)
        guard let p = rest.first, p == "." || p == ")", rest.dropFirst().first == " " else { return nil }
        return (n, rest.dropFirst(2).trimmingCharacters(in: .whitespaces))
    }

    /// Inline Markdown → AttributedString (falls back to plain text).
    public static func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible))) ?? AttributedString(s)
    }
}

/// SwiftUI rendering of an answer.
struct AIMarkdownView: View {
    @Environment(\.glideTheme) private var theme
    let text: String
    var fontSize: CGFloat = 13.5

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(AIMarkdown.parse(text).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func blockView(_ b: AIMarkdownBlock) -> some View {
        switch b {
        case let .heading(level, text):
            Text(AIMarkdown.inline(text)).font(.system(size: fontSize + CGFloat(max(0, 4 - level)) * 1.5, weight: .semibold)).foregroundStyle(theme.text)
        case let .paragraph(t):
            Text(AIMarkdown.inline(t)).font(.system(size: fontSize)).foregroundStyle(theme.text).fixedSize(horizontal: false, vertical: true)
        case let .bullets(items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("•").foregroundStyle(theme.text3)
                        Text(AIMarkdown.inline(it)).fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.system(size: fontSize)).foregroundStyle(theme.text)
                }
            }
        case let .numbered(start, items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("\(start + i).").foregroundStyle(theme.text3).monospacedDigit()
                        Text(AIMarkdown.inline(it)).fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.system(size: fontSize)).foregroundStyle(theme.text)
                }
            }
        case let .quote(t):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1).fill(theme.borderStrong).frame(width: 3)
                Text(AIMarkdown.inline(t)).font(.system(size: fontSize)).foregroundStyle(theme.text2).fixedSize(horizontal: false, vertical: true)
            }
        case let .code(lang, code):
            VStack(alignment: .leading, spacing: 4) {
                if let lang { Text(lang).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(theme.text3) }
                ScrollView(.horizontal) {
                    Text(code).font(.system(size: fontSize - 1, design: .monospaced)).foregroundStyle(theme.text).fixedSize()
                }
                .scrollIndicators(.never)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(theme.surface2))
        case .rule:
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }
}
