import { useEffect, useState, type FormEvent } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { fileIndex, type FileIndexSettings } from "./api";
import { StatusPanel, useIndexStatus } from "./StatusView";

function ListEditor({ label, items, placeholder, onChange }: { label: string; items: string[]; placeholder: string; onChange(next: string[]): void }) {
  const [draft, setDraft] = useState("");
  const add = (e: FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    if (!v || items.includes(v)) return;
    onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="list-edit">
      {items.map((item) => (
        <div key={item} className="list-edit__item">
          <span title={item}>
            <bdi>{item}</bdi>
          </span>
          <button type="button" className="btn btn--sm btn--ghost" aria-label={`Remove ${item}`} onClick={() => onChange(items.filter((i) => i !== item))}>
            Remove
          </button>
        </div>
      ))}
      {!items.length && <div className="list-edit__item fileindex-settings__none">None</div>}
      <form className="list-edit__add" onSubmit={add}>
        <input className="input" aria-label={label} placeholder={placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="btn btn--sm" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

/** Settings ▸ File Search (Raycast: file-search preferences). */
export function SettingsPage() {
  const [s, setS] = useState<FileIndexSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useIndexStatus();

  useEffect(() => {
    void fileIndex.getSettings().then(setS).catch((e: unknown) => setError(String(e)));
  }, []);

  const patch = async (p: Partial<FileIndexSettings>) => {
    try {
      setS(await fileIndex.setSettings(p));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!s) return <div className="page">{error ? <div className="error-banner">{error}</div> : "Loading…"}</div>;
  return (
    <div className="page fileindex-settings">
      {error && <div className="error-banner">{error}</div>}
      <Group title="Index" footer="Glide keeps its own index of file names in these folders (like Raycast's File Search). Contents search (content:…) uses Spotlight.">
        <div className="fileindex-settings__status">
          <StatusPanel status={status} />
          <button type="button" className="btn btn--primary" onClick={() => void fileIndex.rebuild()} disabled={status?.state === "crawling"}>
            {status?.state === "crawling" ? "Indexing…" : "Rebuild Index"}
          </button>
        </div>
      </Group>

      <Group title="Search Scopes" footer="Folders to index. Changing scopes re-crawls in the background.">
        <Row label="Folders" align="start">
          <ListEditor label="Add folder" items={s.scopes} placeholder="~/Projects or /Volumes/Data" onChange={(scopes) => void patch({ scopes })} />
        </Row>
        <Row
          label="Desktop, Documents, Downloads & iCloud Drive"
          hint={s.allowProtectedFolders ? "Included. macOS may have asked for permission once." : "Skipped until you allow it — macOS asks for permission the first time Glide reads them."}
        >
          {s.allowProtectedFolders ? (
            <button type="button" className="btn btn--sm" onClick={() => void patch({ allowProtectedFolders: false })}>
              Stop Indexing
            </button>
          ) : (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void patch({ allowProtectedFolders: true })}>
              Allow Access…
            </button>
          )}
        </Row>
      </Group>

      <Group title="Exclusions" footer="Gitignore syntax (*.log, **/tmp/**, build/) or a full path (~/Downloads/Archive). .gitignore, .ignore, .rayignore and .glideignore files are honoured too. node_modules, .git, build output, caches and ~/Library are always skipped.">
        <Row label="Ignore patterns" align="start">
          <ListEditor label="Add exclusion" items={s.exclusions} placeholder="*.tmp" onChange={(exclusions) => void patch({ exclusions })} />
        </Row>
      </Group>

      <Group title="Options">
        <Row label="Show files in root search" hint="File results appear in the main launcher search">
          <Toggle label="Show files in root search" checked={s.showInRootSearch} onChange={(v) => void patch({ showInRootSearch: v })} />
        </Row>
        <Row label="Include hidden files" hint="Index dot-files and dot-folders">
          <Toggle label="Include hidden files" checked={s.includeHidden} onChange={(v) => void patch({ includeHidden: v })} />
        </Row>
        <Row label="Respect ignore files" hint=".gitignore / .ignore / .rayignore / .glideignore">
          <Toggle label="Respect ignore files" checked={s.respectIgnoreFiles} onChange={(v) => void patch({ respectIgnoreFiles: v })} />
        </Row>
      </Group>
    </div>
  );
}
