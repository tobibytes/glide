/** Row (list mode) and cell (grid mode) renderers for clipboard entries. */
import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { cachedThumb, loadThumbs, type ClipSummary } from "./api";
import { relativeTime, TYPE_LABEL } from "./format";

/** Load thumbnails for the image entries in `list`; re-renders when they arrive. */
export function useThumbs(list: readonly ClipSummary[] | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const ids = (list ?? []).filter((s) => s.type === "image" && !cachedThumb(s.id)).map((s) => s.id);
    if (!ids.length) return;
    let live = true;
    void loadThumbs(ids).then(() => live && setVersion((v) => v + 1));
    return () => {
      live = false;
    };
  }, [list]);
  return version;
}

const fileName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const dirName = (p: string) => p.slice(0, p.lastIndexOf("/")).replace(/^\/Users\/[^/]+/, "~") || "/";

export function TypeIcon({ s }: { s: ClipSummary }) {
  if (s.type === "color") return <Icon icon={{ kind: "color", value: s.preview.trim() }} />;
  if (s.type === "file" && s.files?.[0]) return <Icon icon={{ kind: "file", value: s.files[0] }} fallback="▤" />;
  if (s.type === "image") {
    const t = cachedThumb(s.id);
    if (t) return <img className="clipboard-rowthumb" src={t} alt="" />;
  }
  const glyph = s.type === "image" ? "▣" : s.type === "link" ? "⛓" : "¶";
  return <span className={`icon icon--md icon--symbol clipboard-typeicon clipboard-typeicon--${s.type}`}>{glyph}</span>;
}

/** Second line of a row: what kind of thing it is, then where/when it came from. */
function metaLine(s: ClipSummary): string {
  const parts: string[] = [];
  if (s.type === "link" && s.domain) parts.push(s.domain);
  else if (s.type === "file" && s.files?.[0]) parts.push(s.files.length > 1 ? `${s.files.length} files · ${dirName(s.files[0])}` : dirName(s.files[0]));
  else if (s.type === "image" && s.image) parts.push(`${s.image.width}×${s.image.height}`);
  if (s.source?.name) parts.push(s.source.name);
  parts.push(relativeTime(s.lastCopiedAt));
  if (s.count > 1) parts.push(`×${s.count}`);
  return parts.join(" · ");
}

export function ListRow({ s, selected, marked }: { s: ClipSummary; selected: boolean; marked: boolean }) {
  return (
    <div className={`row clipboard-row ${selected ? "row--selected" : ""} ${marked ? "clipboard-row--marked" : ""}`}>
      {marked ? (
        <span className="clipboard-check" aria-label="Selected">
          ✓
        </span>
      ) : (
        <TypeIcon s={s} />
      )}
      <div className="clipboard-row__main">
        <span className="row__title clipboard-row__title">{s.title}</span>
        <span className="clipboard-row__meta">{metaLine(s)}</span>
      </div>
      {s.pinned && (
        <span className="clipboard-row__pin" aria-label="Pinned" title="Pinned">
          ●
        </span>
      )}
    </div>
  );
}

export function GridCell({ s, selected, marked }: { s: ClipSummary; selected: boolean; marked: boolean }) {
  let body: React.ReactNode;
  if (s.type === "image") {
    const t = cachedThumb(s.id);
    body = t ? <img className="clipboard-cell__img" src={t} alt={s.title} /> : <span className="clipboard-cell__glyph">▣</span>;
  } else if (s.type === "color") {
    body = <span className="clipboard-cell__swatch" style={{ background: s.preview.trim() }} />;
  } else if (s.type === "file" && s.files?.[0]) {
    body = (
      <span className="clipboard-cell__file">
        <Icon icon={{ kind: "file", value: s.files[0] }} size="lg" fallback="▤" />
        <span className="clipboard-cell__filename">{fileName(s.files[0])}</span>
      </span>
    );
  } else if (s.type === "link") {
    body = (
      <span className="clipboard-cell__link">
        <span className="clipboard-cell__domain">{s.domain ?? "link"}</span>
        <span className="clipboard-cell__url">{s.preview.trim()}</span>
      </span>
    );
  } else {
    body = <span className="clipboard-cell__text">{s.preview.slice(0, 160)}</span>;
  }
  const caption = s.type === "image" && s.image ? `${s.image.width}×${s.image.height}` : s.type === "file" ? (s.files && s.files.length > 1 ? `${s.files.length} files` : "File") : s.type === "link" ? "Link" : s.type === "color" ? s.preview.trim() : TYPE_LABEL[s.type];
  return (
    <div className={`clipboard-cell ${selected ? "clipboard-cell--selected" : ""} ${marked ? "clipboard-cell--marked" : ""}`}>
      <div className={`clipboard-cell__body clipboard-cell__body--${s.type}`}>{body}</div>
      <div className="clipboard-cell__caption">
        {marked && <span className="clipboard-check clipboard-check--sm">✓</span>}
        {s.pinned && <span className="clipboard-row__pin">●</span>}
        <span className="clipboard-cell__captiontext">{caption}</span>
        <span className="clipboard-cell__time">{relativeTime(s.lastCopiedAt)}</span>
      </div>
    </div>
  );
}
