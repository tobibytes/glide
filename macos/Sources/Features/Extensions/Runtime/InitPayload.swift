import Foundation
import GlideCore

enum InitPayload {
    static let glideVersion = "0.3.0"

    /// The `init` message body (InitPayload in src/extension-api/types.ts). apiPath / shimDir are set by entry.ts.
    static func make(ext: InstalledExtension, manifest m: ExtManifest, command cmd: ExtCommand, arguments: [String: String],
                     preferences: [String: JSONValue], supportPath: String, launchType: String = "userInitiated",
                     launchContext: JSONValue = .null, aiAvailable: Bool = false) -> JSONValue {
        let assets = ext.dir.appendingPathComponent("assets").path
        return [
            "commandPath": .string(ext.dir.appendingPathComponent(cmd.entry).path),
            "apiPath": "",
            "runtime": .string(m.runtime),
            "launchContext": launchContext,
            "launchType": .string(launchType),
            "capabilities": ["ai": .bool(aiAvailable)],
            "arguments": .object(arguments.mapValues(JSONValue.string)),
            "preferences": .object(preferences),
            "environment": [
                "extensionName": .string(m.name),
                "extensionTitle": .string(m.title),
                "commandName": .string(cmd.name),
                "commandMode": .string(cmd.mode),
                "assetsPath": .string(assets),
                "extensionPath": .string(ext.dir.path),
                "supportPath": .string(supportPath),
                "glideVersion": .string(glideVersion),
            ],
        ]
    }
}
