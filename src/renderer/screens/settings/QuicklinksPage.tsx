import { useState } from "react";
import type { ItemIcon, Quicklink, UserData } from "@shared/types";
import { glide } from "../../lib/glide";
import { navigateTo } from "../../lib/route";
import { Icon } from "../../components/Icon";
import { QuicklinkForm } from "./quicklinks/QuicklinkForm";
import { BookmarkPicker } from "./quicklinks/BookmarkPicker";
import { importSummary, quicklinksApi } from "./quicklinks/api";

const DEFAULT_ICON: ItemIcon = { kind: "emoji", value: "🔗" };
const errText = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

export function QuicklinksPage({ data, editId }: { data: UserData; editId?: string }) {
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [picking, setPicking] = useState(false);
  const [paste, setPaste] = useState<string | null>(null);

  if (editId) {
    const existing = editId === "new" ? undefined : data.quicklinks.find((q) => q.id === editId || `quicklink:${q.id}` === editId);
    if (editId !== "new" && !existing) return <div className="empty">Quicklink not found.</div>;
    return <QuicklinkEditor key={editId} initial={existing} />;
  }

  const run = async (fn: () => Promise<string>) => {
    try {
      setNotice({ text: await fn() });
    } catch (err) {
      setNotice({ text: errText(err), error: true });
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <p className="page__lead" style={{ margin: 0 }}>
          Open URLs from the launcher. Arguments like <code>{'{argument name="query"}'}</code> are typed after the name — Tab moves to the next one.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => navigateTo("quicklinks", "new")}>
          New Quicklink
        </button>
      </div>
      <div className="qltools" role="toolbar" aria-label="Import and export">
        <button type="button" className="btn btn--sm" onClick={() => setPicking((p) => !p)} data-ql-bookmarks>
          Import from Bookmarks…
        </button>
        <button type="button" className="btn btn--sm" onClick={() => void run(async () => importSummary(await quicklinksApi.importFile(), "quicklink"))}>
          Import JSON File…
        </button>
        <button type="button" className="btn btn--sm" onClick={() => setPaste(paste === null ? "" : null)}>
          Paste JSON…
        </button>
        <button type="button" className="btn btn--sm" onClick={() => void run(async () => ((await quicklinksApi.exportFile()) ? "Exported" : "Export cancelled"))}>
          Export JSON File…
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            void run(async () => {
              await navigator.clipboard.writeText(await quicklinksApi.exportJson());
              return "Quicklinks JSON copied";
            })
          }
        >
          Copy JSON
        </button>
      </div>
      {notice && <div className={notice.error ? "error-banner" : "notice-banner qlnotice"} data-ql-notice>{notice.text}</div>}
      {paste !== null && (
        <div className="qlpaste">
          <textarea className="textarea mono" rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='[{"name": "Docs", "link": "https://docs.example.com/search?q={argument name=&quot;q&quot;}"}]' aria-label="Quicklinks JSON" data-ql-paste />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() =>
              void run(async () => {
                const r = await quicklinksApi.importJson(paste);
                setPaste(null);
                return importSummary(r, "quicklink");
              })
            }
            data-ql-paste-import
          >
            Import
          </button>
          <span className="field__hint">Glide exports and Raycast's quicklink export (name, link, openWith) both work.</span>
        </div>
      )}
      {picking && (
        <BookmarkPicker
          onDone={(text) => {
            setNotice({ text });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
      <div className="table">
        {data.quicklinks.length === 0 && <div className="empty">No quicklinks yet.</div>}
        {data.quicklinks.map((q) => (
          <div key={q.id} className="trow" onDoubleClick={() => navigateTo("quicklinks", q.id)}>
            <Icon icon={q.icon ?? DEFAULT_ICON} size="lg" />
            <div className="trow__main">
              <div className="trow__title">
                {q.name}
                {q.alias && <span className="tag tag--accent">{q.alias}</span>}
                {q.openWith && <span className="tag">{q.openWith.split("/").pop()?.replace(/\.app$/, "")}</span>}
              </div>
              <div className="trow__sub">{q.url}</div>
            </div>
            <div className="trow__meta">{q.keywords?.length ? q.keywords.join(", ") : null}</div>
            <div className="trow__actions">
              <button type="button" className="btn btn--sm" onClick={() => navigateTo("quicklinks", q.id)}>
                Edit
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuicklinkEditor({ initial }: { initial?: Quicklink }) {
  const remove = async () => {
    if (!initial || !confirm(`Delete “${initial.name}”?`)) return;
    await glide().deleteQuicklink(initial.id);
    navigateTo("quicklinks");
  };
  return (
    <div className="page">
      <h2 className="page__title">{initial ? "Edit Quicklink" : "New Quicklink"}</h2>
      <p className="page__lead">Quicklinks open in your default browser, or in the app you choose.</p>
      <QuicklinkForm initial={initial} onSaved={() => navigateTo("quicklinks")} onCancel={() => navigateTo("quicklinks")} onDelete={initial ? () => void remove() : undefined} />
    </div>
  );
}
