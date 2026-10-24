import GlideCore

/// Every feature module, in catalogue order. Phase-1 sessions: add ONE line for your feature (keep the list
/// alphabetical after the built-ins to minimise merge conflicts).
@MainActor public enum AllFeatures {
    public static func make() -> [any Feature] {
        [
            // built-ins (phase 0)
            ApplicationsFeature(),
            SystemCommandsFeature(),
            CalculatorFeature(),
            Quicklinks2Feature(), // N1: Quicklinks 2.0 replaces the phase-0 QuicklinksFeature (same id "quicklinks")
            // phase-1 features (alphabetical)
            AgentFeature(), // N5: Glide Agent + MCP client
            AIFeature().servingGlideAgent(), // N4 (N5: the agent uses its client)
            AppFeature(), // N8: updates, launch at login, General page
            AppearanceFeature(), // N8
            AutomationsFeature(), // N6
            BrowserFeature(), // N7
            CalendarFeature(), // N7
            ClipboardFeature(), // N2: Clipboard History + Paste Stack
            ColorFeature(), // N7
            ConvertFeature(),
            EmojiFeature(),
            ExtensionsFeature(), // N9: extensions (JavaScriptCore), Store
            FallbacksFeature(),
            FilesFeature(),
            FinderFeature(),
            FocusFeature(), // N7
            KeyboardFeature(),
            LayoutsFeature(),
            MCPServerFeature(), // N5
            MenuBarFeature(), // N8
            MenusFeature(),
            NotesFeature(), // N7
            OCRFeature(), // N7
            OnboardingFeature(), // N8
            PhoneFeature(), // Glide on iPhone (docs/PHONE.md)
            ProcessesFeature(),
            RemindersFeature(), // N7
            ScriptCommandsFeature(), // N9
            Snippets2Feature(), // N2: Snippets 2.0 (snippet:<id> rows, live expansion, Search Snippets, editor)
            SyncFeature(), // N8
            SysCmdsFeature(),
            SystemMonitorFeature(),
            TimersFeature(), // N7
            TransformsFeature(), // N4
            WindowsFeature(),
            WorkflowEngineFeature(), // N6: supersedes the phase-0 WorkflowsFeature (same id "workflows")
        ]
    }
}
