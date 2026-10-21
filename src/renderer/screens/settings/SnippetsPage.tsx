import { useEffect, useState } from "react";
import type { Snippet, UserData } from "@shared/types";
import { glide } from "../../lib/glide";
import { navigateTo } from "../../lib/route";
import { Group, Row, Toggle } from "../../components/form";
import { importSummary, snippetsApi, type SnippetSettings } from "./quicklinks/api";
import { SnippetEditor } from "./snippets/SnippetEditor";

const errText = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

function useSnippetSettings(): [SnippetSettings | null, (patch: Partial<SnippetSettings>) => void] {
  const [s, setS] = useState<SnippetSettings | null>(null);
  useEffect(() => {
    void snippetsApi.getSettings().then(setS).catch(() => setS({ keywordPrefix: "", caseAdaptive: false, excludedApps: [] }));
  }, []);
  return [s, (patch) => void snippetsApi.setSettings(patch).then(setS)];
}

export function SnippetsPage({ data, editId }: { data: UserData; editId?: string }) {
  const [settings, update] = useSnippetSettings();
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
  const [excludedDraft, setExcludedDraft] = useState<string | null>(null);

  if (editId) {
    const existing = editId === "new" ? undefined : data.snippets.find((s) => s.id === editId || `snippet:${s.id}` === editId);
    if (editId !== "new" && !existing) return <div className="empty">Snippet not found.</div>;
    return <EditorPage key={editId} initial={existing} settings={settings} />;
  }

  const run = async (fn: () => Promise<string>) => {
    try {
      setNotice({ text: await fn() });
    } catch (err) {
      setNotice({ text: errText(err), error: true });
    }
  };
  const prefix = settings?.keywordPrefix ?? "";
  const shown = (s: Snippet) => (s.keyword ? (prefix && !s.keyword.startsWith(prefix) ? prefix + s.keyword : s.keyword) : "");

  return (
    <div className="page" data-snippets-page>
      <div className="page__head">
        <p className="page__lead" style={{ margin: 0 }}>
          Paste reusable text from the launcher, or type a keyword anywhere to expand it. Placeholders: <code>{"{cursor}"}</code> <code>{"{clipboard}"}</code> <code>{'{date format="…" offset="+1d"}'}</code> <code>{'{snippet name="…"}'}</code>.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => navigateTo("snippets", "new")}>
          New Snippet
        </button>
      </div>

      <Group title="Expansion" footer={<>A prefix stops accidental expansion inside words: with “;”, the keyword “sig” only expands after “;sig”, never in “design”.</>}>
        <Row label="Keyword prefix" hint="Added in front of every keyword that doesn't already start with it" htmlFor="sn-prefix">
          <input
            id="sn-prefix"
            className="input mono"
            style={{ width: 90 }}
            value={prefixDraft ?? prefix}
            maxLength={4}
            placeholder="none"
            onChange={(e) => setPrefixDraft(e.target.value)}
            onBlur={() => {
              if (prefixDraft !== null) update({ keywordPrefix: prefixDraft });
              setPrefixDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            data-sn-prefix
          />
        </Row>
        <Row label="Case-adaptive expansion" hint="“Sig” expands capitalised, “SIG” in upper case">
          <Toggle checked={!!settings?.caseAdaptive} onChange={(v) => update({ caseAdaptive: v })} label="Case-adaptive expansion" />
        </Row>
        <Row label="Never expand in" hint="Bundle ids, comma separated (applies to every snippet)" htmlFor="sn-gexcl">
          <input
            id="sn-gexcl"
            className="input mono"
            style={{ width: 280 }}
            value={excludedDraft ?? (settings?.excludedApps ?? []).join(", ")}
            placeholder="com.apple.Terminal"
            onChange={(e) => setExcludedDraft(e.target.value)}
            onBlur={() => {
              if (excludedDraft !== null) update({ excludedApps: excludedDraft.split(",").map((x) => x.trim()).filter(Boolean) });
              setExcludedDraft(null);
            }}
          />
        </Row>
      </Group>

      <div className="qltools" role="toolbar" aria-label="Import and export">
        <button type="button" className="btn btn--sm" onClick={() => void run(async () => importSummary(await snippetsApi.importFile(), "snippet"))}>
          Import Raycast / Glide JSON…
        </button>
        <button type="button" className="btn btn--sm" onClick={() => setPaste(paste === null ? "" : null)} data-sn-paste-toggle>
          Paste JSON…
        </button>
        <button type="button" className="btn btn--sm" onClick={() => void run(async () => ((await snippetsApi.exportFile()) ? "Exported" : "Export cancelled"))}>
          Export JSON File…
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            void run(async () => {
              await navigator.clipboard.writeText(await snippetsApi.exportJson());
              return "Snippets JSON copied";
            })
          }
        >
          Copy JSON
        </button>
      </div>
      {notice && <div className={notice.error ? "error-banner" : "notice-banner qlnotice"} data-sn-notice>{notice.text}</div>}
      {paste !== null && (
        <div className="qlpaste">
          <textarea className="textarea mono" rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='[{"name": "Signature", "text": "Best,\n{cursor}", "keyword": "!sig"}]' aria-label="Snippets JSON" data-sn-paste />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            data-sn-paste-import
            onClick={() =>
              void run(async () => {
                const r = await snippetsApi.importJson(paste);
                setPaste(null);
                return importSummary(r, "snippet");
              })
            }
          >
            Import
          </button>
          <span className="field__hint">Raycast: Snippets → ⌘K → Export Snippets produces this format.</span>
        </div>
      )}

      <div className="table">
        {data.snippets.length === 0 && <div className="empty">No snippets yet.</div>}
        {data.snippets.map((s) => (
          <div key={s.id} className="trow" onDoubleClick={() => navigateTo("snippets", s.id)} data-sn-row={s.name}>
            <span className="icon icon--lg">{s.html ? "🅰︎" : "✂️"}</span>
            <div className="trow__main">
              <div className="trow__title">
                {s.name}
                {s.keyword && <span className="tag mono">{shown(s)}</span>}
                {s.alias && <span className="tag tag--accent">{s.alias}</span>}
                {s.html && <span className="tag">rich</span>}
                {s.excludedApps?.length ? <span className="tag" title={s.excludedApps.join(", ")}>{s.excludedApps.length} excluded</span> : null}
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

function EditorPage({ initial, settings }: { initial?: Snippet; settings: SnippetSettings | null }) {
  const remove = async () => {
    if (!initial || !confirm(`Delete “${initial.name}”?`)) return;
    await glide().deleteSnippet(initial.id);
    navigateTo("snippets");
  };
  return (
    <div className="page">
      <h2 className="page__title">{initial ? "Edit Snippet" : "New Snippet"}</h2>
      <p className="page__lead">Selecting a snippet in the launcher pastes it into the frontmost app; its keyword expands as you type.</p>
      <SnippetEditor initial={initial} settings={settings} onDone={() => navigateTo("snippets")} onDelete={initial ? () => void remove() : undefined} />
    </div>
  );
}
