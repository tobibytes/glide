// swift-tools-version: 6.0
// Glide — native macOS shell (phase 0 foundation). See README.md and docs/ARCHITECTURE.md.
import PackageDescription

let strict: [SwiftSetting] = [
    .swiftLanguageMode(.v6),
]

let package = Package(
    name: "Glide",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Glide", targets: ["Glide"]),
        .library(name: "GlideCore", targets: ["GlideCore"]),
        .library(name: "GlideSystem", targets: ["GlideSystem"]),
        .library(name: "GlideUI", targets: ["GlideUI"]),
    ],
    targets: [
        // Pure Swift: data model, search engine, Feature protocol, Store, vim, themes. No AppKit.
        .target(name: "GlideCore", path: "Sources/GlideCore", swiftSettings: strict),
        // AppKit / ApplicationServices: the former glide-helper, behind protocols (+ headless fakes).
        .target(
            name: "GlideSystem",
            dependencies: ["GlideCore"],
            path: "Sources/GlideSystem",
            swiftSettings: strict,
            linkerSettings: [
                .linkedFramework("AppKit"), .linkedFramework("Carbon"), .linkedFramework("ApplicationServices"),
                .linkedFramework("EventKit"), .linkedFramework("Vision"), .linkedFramework("CoreWLAN"),
                .linkedFramework("CoreLocation"),
            ]
        ),
        // SwiftUI design system and launcher components.
        .target(name: "GlideUI", dependencies: ["GlideCore"], path: "Sources/GlideUI", swiftSettings: strict),
        // Feature modules: one folder per feature (Sources/Features/<Name>), registered in AllFeatures.swift.
        .target(
            name: "GlideFeatures",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI"],
            path: "Sources/Features",
            exclude: ["Phone/Web"], // the Glide Remote web app; embedded by scripts/embed-phone-web.sh (PhoneWebAssets.swift)
            swiftSettings: strict
        ),
        // The app: AppKit lifecycle, launcher NSPanel, settings window, menu bar, test server.
        .executableTarget(
            name: "Glide",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures"],
            path: "Sources/GlideApp",
            swiftSettings: strict
        ),
        .testTarget(
            name: "GlideCoreTests",
            dependencies: ["GlideCore"],
            path: "Tests/GlideCoreTests",
            resources: [.copy("Fixtures")],
            swiftSettings: strict
        ),
        .testTarget(
            name: "GlideSystemTests",
            dependencies: ["GlideCore", "GlideSystem"],
            path: "Tests/GlideSystemTests",
            resources: [.copy("Fixtures")],
            swiftSettings: strict
        ),
        // N7 feature logic (Notes, Timers, Focus, Calendar, Reminders, Color, OCR, Browser).
        .testTarget(
            name: "N7FeatureTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures"],
            path: "Tests/N7FeatureTests",
            swiftSettings: strict
        ),
        // N1 feature logic (Files, Conversions, Calculator, Fallbacks, Quicklinks 2.0, Emoji).
        .testTarget(
            name: "N1FeatureTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures", "GlideTestHarness"],
            path: "Tests/N1FeatureTests",
            swiftSettings: strict
        ),
        // N8 feature logic (Onboarding, Appearance, Menu Bar, Sync, Updates, General settings).
        .testTarget(
            name: "N8FeatureTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures"],
            path: "Tests/N8FeatureTests",
            swiftSettings: strict
        ),
        // N4 feature logic (AI client/keys/migration/chats/templates, Text Transforms).
        .testTarget(
            name: "N4FeatureTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures", "GlideTestHarness"],
            path: "Tests/N4FeatureTests",
            swiftSettings: strict
        ),
        // N5 feature logic (Agent loop/tools, MCP client + server). The fixture MCP server is built first.
        .executableTarget(name: "mcp-fixture-server", path: "Tests/MCPFixtureServer", swiftSettings: strict),
        .testTarget(
            name: "N5FeatureTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures", "GlideTestHarness", "mcp-fixture-server", "Glide"],
            path: "Tests/N5FeatureTests",
            swiftSettings: strict
        ),
        // N6 feature logic (Workflows runtime/editor model, Automations engine/triggers).
        .testTarget(
            name: "N6FeatureTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures", "GlideTestHarness"],
            path: "Tests/N6FeatureTests",
            swiftSettings: strict
        ),
        // Reusable driver: spawns `Glide --test-server` headless with a temp GLIDE_USER_DATA (docs/TESTING.md).
        // N9: Extensions (JavaScriptCore host), Store, Script Commands.
        .testTarget(
            name: "N9FeatureTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures", "GlideTestHarness"],
            path: "Tests/N9FeatureTests",
            swiftSettings: strict
        ),
        // N2: Clipboard History, Paste Stack, Snippets 2.0, pasteboard watcher, keyboard-tap composer.
        .testTarget(
            name: "N2FeatureTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures"],
            path: "Tests/N2FeatureTests",
            swiftSettings: strict
        ),
        // N3: Windows, Layouts, Menus, Keyboard, Finder, Processes, System Monitor, System Commands.
        .testTarget(
            name: "N3FeatureTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures"],
            path: "Tests/N3FeatureTests",
            swiftSettings: strict
        ),
        // Glide on iPhone, phone-notify: ntfy notifications, Glide Agent from the phone, approvals.
        .testTarget(
            name: "PhoneNotifyTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures", "GlideTestHarness", "Glide"],
            path: "Tests/PhoneNotifyTests",
            swiftSettings: strict
        ),
        // Glide on iPhone, phone-core: envelope crypto, gate/policies/confirmations, pairing, core actions, LAN E2E.
        .testTarget(
            name: "PhoneCoreTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures", "GlideTestHarness", "Glide"],
            path: "Tests/PhoneCoreTests",
            swiftSettings: strict
        ),
        // Glide on iPhone, phone-relay: iCloud Drive relay, clipboard mirror, Shortcuts generation, relay E2E.
        .testTarget(
            name: "PhoneRelayTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures", "GlideTestHarness", "Glide"],
            path: "Tests/PhoneRelayTests",
            swiftSettings: strict
        ),
        // Glide on iPhone, phone-web: web app crypto (RFC 8439 + CryptoKit cross-check), remote/file actions, web E2E.
        .testTarget(
            name: "PhoneWebTests",
            dependencies: ["GlideCore", "GlideSystem", "GlideUI", "GlideFeatures", "GlideTestHarness", "Glide"],
            path: "Tests/Phone",
            exclude: ["crypto-vectors.mjs", "rfc8439-vectors.json", "extract-rfc8439-vectors.py", "web-e2e.mjs"],
            swiftSettings: strict
        ),
        .target(name: "GlideTestHarness", path: "Tests/Harness", exclude: ["glide-driver.mjs"], swiftSettings: strict),
        // End-to-end: drives the real Glide binary over the test channel. Depends on the executable so
        // `swift test` builds it first.
        .testTarget(
            name: "GlideAppTests",
            dependencies: ["Glide", "GlideTestHarness"],
            path: "Tests/GlideAppTests",
            resources: [.copy("fixture-data.json")],
            swiftSettings: strict
        ),
    ]
)
