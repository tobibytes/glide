import AppKit

/// Quits Glide safely from anywhere.
///
/// `NSApp.terminate` must not run inside a main-queue block or a Swift task (both are main-queue work): Glide's
/// `applicationShouldTerminate` answers `.terminateLater` and finishes shutdown in a main-actor task, while AppKit
/// waits in a nested run loop that cannot drain the main queue it is already inside. The shutdown task then never
/// runs and Glide hangs half-quit (Quit stops responding too). Scheduling terminate on the run loop instead of the
/// main queue makes AppKit's wait drain the queue normally.
public enum GlideQuit {
    @MainActor public static func request() {
        NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
    }
}
