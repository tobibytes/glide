import Foundation
import GlideCore
import GlideSystem

/// The Mac side of the web app's Remote and Files screens:
/// `pointer.move/click/scroll`, `keys.press`, `type.text`, `slides.next/prev` (group "remote") and
/// `files.search` / `files.get` (group "files"). All are LAN-only. The web app itself is static (PhoneWebAssets).
@MainActor enum PhoneRemote {
    static func install(_ feature: PhoneFeature) async {
        guard let context = feature.context else { return }
        let env = ProcessInfo.processInfo.environment
        let input: any RemoteInputService
        if context.services.isHeadless {
            // GLIDE_HEADLESS_AX=0 simulates a Mac where Glide has no Accessibility permission.
            input = HeadlessRemoteInput(trusted: env["GLIDE_HEADLESS_AX"] != "0") { [weak context] kind, detail in
                context?.recordEffect(kind: kind, detail: detail)
            }
        } else {
            input = CGEventRemoteInput()
        }
        let files = PhoneFiles(
            home: PhoneFiles.home(headless: context.services.isHeadless, environment: env),
            backendKind: env["GLIDE_FILES_BACKEND"] ?? (context.services.isHeadless ? "scan" : "spotlight"),
            fileSettings: { [weak context] in context?.store.settings.features["fileindex"] ?? [:] },
            headless: context.services.isHeadless)
        PhoneRemoteActions.register(on: feature.registry, input: input, files: files)
    }
}
