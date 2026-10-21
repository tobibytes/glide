/** Launcher views for the quicklinks feature: Create Quicklink and Import from Bookmarks. */
import { useEffect, useState } from "react";
import type { ViewProps } from "../../../features/types";
import { QuicklinkForm } from "./QuicklinkForm";
import { BookmarkPicker } from "./BookmarkPicker";
import { quicklinksApi } from "./api";

export function CreateQuicklinkView({ props, setPlaceholder, pop, toast }: ViewProps<{ url?: string; name?: string }>) {
  const [initialUrl, setInitialUrl] = useState<string | null>(props.url ?? null);
  useEffect(() => setPlaceholder("Fill in the form — ⌘⏎ saves, ⎋ goes back"), [setPlaceholder]);
  useEffect(() => {
    if (initialUrl !== null) return;
    // Prefill from a URL on the clipboard (read only in main; never written).
    void quicklinksApi
      .clipboardUrl()
      .then((u) => setInitialUrl(u))
      .catch(() => setInitialUrl(""));
  }, [initialUrl]);
  if (initialUrl === null) return <div className="launcher__empty">Loading…</div>;
  return (
    <div className="qlview" data-view-ql-create>
      <QuicklinkForm
        compact
        initial={{ url: initialUrl, ...(props.name ? { name: props.name } : {}) }}
        onSaved={(q) => {
          toast(`Saved quicklink “${q.name}”${q.icon?.kind === "url" ? " with its website icon" : ""}`);
          pop();
        }}
        onCancel={pop}
      />
    </div>
  );
}

export function BookmarksImportView({ setPlaceholder, pop, toast }: ViewProps) {
  useEffect(() => setPlaceholder("Filter in the list below — ⏎ selects, ⌘⏎ imports"), [setPlaceholder]);
  return (
    <div className="qlview">
      <BookmarkPicker
        onDone={(m) => {
          toast(m);
          pop();
        }}
        onClose={pop}
      />
    </div>
  );
}
