import { useEffect, useState } from "react";
import type { Snippet, UserData } from "@shared/types";
import { glide } from "../../lib/glide";
import { navigateTo } from "../../lib/route";
import { Field } from "../../components/form";

export function SnippetsPage({ data, editId }: { data: UserData; editId?: string }) {
  if (editId) {
    const existing = editId === "new" ? undefined : data.snippets.find((s) => s.id === editId || `snippet:${s.id}` === editId);
    if (editId !== "new" && !existing) return <div className="empty">Snippet not found.</div>;
    return <SnippetEditor key={editId} initial={existing} />;
  }
  return (
    <div className="page">
      <div className="page__head">
        <p className="page__lead" style={{ margin: 0 }}>
          Paste reusable text from the launcher.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => navigateTo("snippets", "new")}>
          New Snippet
        </button>
      </div>
      <div className="table">
        {data.snippets.length === 0 && <div className="empty">No snippets yet.</div>}
        {data.snippets.map((s) => (
          <div key={s.id} className="trow" onDoubleClick={() => navigateTo("snippets", s.id)}>
            <span className="icon icon--lg">✂️</span>
            <div className="trow__main">
              <div className="trow__title">
                {s.name}
                {s.keyword && <span className="tag">{s.keyword}</span>}
                {s.alias && <span className="tag tag--accent">{s.alias}</span>}
              </div>
              <div className="trow__sub">{s.text.replace(/\s+/g, " ").slice(0, 120)}</div>
            </div>
            <div className="trow__actions">
              <button type="button" className="btn btn--sm" onClick={() => navigateTo("snippets", s.id)}>
                Edit
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SnippetEditor({ initial }: { initial?: Snippet }) {
  const [s, setS] = useState<Snippet>(initial ?? { id: "", name: "", text: "", keyword: "", alias: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.getElementById("sn-name")?.focus();
  }, []);

  const save = async () => {
    if (!s.name.trim() || !s.text) {
      setError("Name and text are required.");
      return;
    }
    setBusy(true);
    try {
      await glide().saveSnippet({ ...s, name: s.name.trim(), keyword: s.keyword?.trim() || undefined, alias: s.alias?.trim() || undefined });
      navigateTo("snippets");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!initial || !confirm(`Delete “${initial.name}”?`)) return;
    await glide().deleteSnippet(initial.id);
    navigateTo("snippets");
  };

  return (
    <div className="page">
      <h2 className="page__title">{initial ? "Edit Snippet" : "New Snippet"}</h2>
      <p className="page__lead">Selecting a snippet in the launcher pastes its text into the frontmost app.</p>
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
        <Field label="Name" htmlFor="sn-name">
          <input id="sn-name" className="input" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Email signature" />
        </Field>
        <Field label="Text" htmlFor="sn-text">
          <textarea id="sn-text" className="textarea mono" rows={6} value={s.text} onChange={(e) => setS({ ...s, text: e.target.value })} placeholder="Best regards,&#10;Olu" />
        </Field>
        <div className="form__grid">
          <Field label="Keyword" htmlFor="sn-kw" hint="Searchable keyword for this snippet">
            <input id="sn-kw" className="input" value={s.keyword ?? ""} onChange={(e) => setS({ ...s, keyword: e.target.value })} placeholder="sig" />
          </Field>
          <Field label="Alias" htmlFor="sn-alias" hint="Short word that ranks this snippet first">
            <input id="sn-alias" className="input" value={s.alias ?? ""} onChange={(e) => setS({ ...s, alias: e.target.value })} />
          </Field>
        </div>
        <div className="form__actions">
          <div>{initial && <button type="button" className="btn btn--danger" onClick={() => void remove()}>Delete</button>}</div>
          <div>
            <button type="button" className="btn" onClick={() => navigateTo("snippets")}>
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
