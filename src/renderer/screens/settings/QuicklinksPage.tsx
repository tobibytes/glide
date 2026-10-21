import { useEffect, useState } from "react";
import type { ItemIcon, Quicklink, UserData } from "@shared/types";
import { glide } from "../../lib/glide";
import { navigateTo } from "../../lib/route";
import { Icon } from "../../components/Icon";
import { IconPicker } from "../../components/IconPicker";
import { Field } from "../../components/form";

const DEFAULT_ICON: ItemIcon = { kind: "emoji", value: "🔗" };

export function QuicklinksPage({ data, editId }: { data: UserData; editId?: string }) {
  if (editId) {
    const existing = editId === "new" ? undefined : data.quicklinks.find((q) => q.id === editId || `quicklink:${q.id}` === editId);
    if (editId !== "new" && !existing) return <div className="empty">Quicklink not found.</div>;
    return <QuicklinkEditor key={editId} initial={existing} />;
  }
  return (
    <div className="page">
      <div className="page__head">
        <p className="page__lead" style={{ margin: 0 }}>
          Open URLs from the launcher. Use <code>{"{query}"}</code> to insert text typed after the name.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => navigateTo("quicklinks", "new")}>
          New Quicklink
        </button>
      </div>
      <div className="table">
        {data.quicklinks.length === 0 && <div className="empty">No quicklinks yet.</div>}
        {data.quicklinks.map((q) => (
          <div key={q.id} className="trow" onDoubleClick={() => navigateTo("quicklinks", q.id)}>
            <Icon icon={q.icon ?? DEFAULT_ICON} size="lg" />
            <div className="trow__main">
              <div className="trow__title">
                {q.name}
                {q.alias && <span className="tag tag--accent">{q.alias}</span>}
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
  const [q, setQ] = useState<Quicklink>(initial ?? { id: "", name: "", url: "", icon: DEFAULT_ICON, alias: "", keywords: [] });
  const [keywords, setKeywords] = useState((initial?.keywords ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.getElementById("ql-name")?.focus();
  }, []);

  const save = async () => {
    if (!q.name.trim() || !q.url.trim()) {
      setError("Name and URL are required.");
      return;
    }
    setBusy(true);
    try {
      await glide().saveQuicklink({ ...q, name: q.name.trim(), url: q.url.trim(), alias: q.alias?.trim() || undefined, keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean) });
      navigateTo("quicklinks");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!initial || !confirm(`Delete “${initial.name}”?`)) return;
    await glide().deleteQuicklink(initial.id);
    navigateTo("quicklinks");
  };

  return (
    <div className="page">
      <h2 className="page__title">{initial ? "Edit Quicklink" : "New Quicklink"}</h2>
      <p className="page__lead">Quicklinks open in your default browser.</p>
      {error && <div className="error-banner">{error}</div>}
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => {
          if (e.metaKey && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save();
          }
        }}
      >
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <IconPicker value={q.icon ?? DEFAULT_ICON} onChange={(icon) => setQ({ ...q, icon })} />
          <div style={{ flex: 1 }}>
            <Field label="Name" htmlFor="ql-name">
              <input id="ql-name" className="input" value={q.name} onChange={(e) => setQ({ ...q, name: e.target.value })} placeholder="Google" />
            </Field>
          </div>
        </div>
        <Field label="URL" htmlFor="ql-url" hint={<>Use <code>{"{query}"}</code> where the typed argument should go, e.g. https://www.google.com/search?q={"{query}"}</>}>
          <input id="ql-url" className="input mono" value={q.url} onChange={(e) => setQ({ ...q, url: e.target.value })} placeholder="https://example.com/search?q={query}" />
        </Field>
        <div className="form__grid">
          <Field label="Alias" htmlFor="ql-alias" hint="Short word that ranks this link first">
            <input id="ql-alias" className="input" value={q.alias ?? ""} onChange={(e) => setQ({ ...q, alias: e.target.value })} placeholder="g" />
          </Field>
          <Field label="Keywords" htmlFor="ql-kw" hint="Comma separated extra search terms">
            <input id="ql-kw" className="input" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="search, web" />
          </Field>
        </div>
        <div className="form__actions">
          <div>{initial && <button type="button" className="btn btn--danger" onClick={() => void remove()}>Delete</button>}</div>
          <div>
            <button type="button" className="btn" onClick={() => navigateTo("quicklinks")}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              Save
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
