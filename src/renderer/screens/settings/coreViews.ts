/**
 * Launcher views for the built-in quicklinks and snippets features. They register themselves into
 * the feature UI map (an additive assignment, so src/renderer/features/registry.ts stays untouched);
 * imported once from the launcher.
 */
import type { ComponentType } from "react";
import { FEATURE_UIS } from "../../features/registry";
import type { ViewProps } from "../../features/types";
import { BookmarksImportView, CreateQuicklinkView } from "./quicklinks/views";
import { SearchSnippetsView } from "./snippets/SearchSnippetsView";

FEATURE_UIS.quicklinks ??= {
  views: {
    create: CreateQuicklinkView as ComponentType<ViewProps>,
    bookmarks: BookmarksImportView as ComponentType<ViewProps>,
  },
};
FEATURE_UIS.snippets ??= {
  views: { search: SearchSnippetsView as ComponentType<ViewProps> },
};
