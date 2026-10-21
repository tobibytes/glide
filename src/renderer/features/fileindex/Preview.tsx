import { useEffect, useState } from "react";
import { fileIndex, type FileHitDTO, type PreviewDTO } from "./api";
import { formatDate, formatSize, iconSrc } from "./format";

const cache = new Map<string, PreviewDTO>();

/** Quick Look-style detail pane: thumbnail, first 4 KB of text, metadata. */
export function Preview({ hit }: { hit: FileHitDTO }) {
  const [preview, setPreview] = useState<PreviewDTO | null>(cache.get(hit.path) ?? null);
  const [thumbBroken, setThumbBroken] = useState(false);

  useEffect(() => {
    let alive = true;
    setThumbBroken(false);
    const cached = cache.get(hit.path);
    setPreview(cached ?? null);
    if (!cached) {
      // Small delay so holding ↓ through a long list doesn't read every file.
      const t = setTimeout(() => {
        void fileIndex.readPreview(hit.path).then((p) => {
          if (cache.size > 200) cache.clear();
          cache.set(hit.path, p);
          if (alive) setPreview(p);
        }).catch(() => undefined);
      }, 60);
      return () => {
        alive = false;
        clearTimeout(t);
      };
    }
    return () => {
      alive = false;
    };
  }, [hit.path]);

  const p = preview;
  const showText = p?.text !== undefined;
  return (
    <div className="fileindex-preview" data-path={hit.path}>
      {showText ? (
        <pre className="fileindex-preview__text">
          {p!.text}
          {p!.truncated && <span className="fileindex-preview__more">…</span>}
        </pre>
      ) : (
        <div className="fileindex-preview__thumb">
          {!thumbBroken ? <img src={iconSrc(hit.path)} alt="" draggable={false} onError={() => setThumbBroken(true)} /> : <span className="fileindex-preview__glyph">{hit.isDir ? "▣" : "▤"}</span>}
        </div>
      )}
      <div className="fileindex-preview__name">{hit.name}</div>
      <dl className="fileindex-preview__meta">
        <dt>Kind</dt>
        <dd>{p?.kindLabel ?? hit.kindLabel}</dd>
        {!hit.isDir && (
          <>
            <dt>Size</dt>
            <dd>{formatSize(p?.size ?? hit.size)}</dd>
          </>
        )}
        {p?.childCount !== undefined && (
          <>
            <dt>Items</dt>
            <dd>{p.childCount}</dd>
          </>
        )}
        <dt>Modified</dt>
        <dd>{formatDate(p?.mtime ?? hit.mtime)}</dd>
        {p?.birthtime ? (
          <>
            <dt>Created</dt>
            <dd>{formatDate(p.birthtime)}</dd>
          </>
        ) : null}
        <dt>Where</dt>
        <dd className="fileindex-preview__path" title={hit.path}>
          {hit.path}
        </dd>
      </dl>
      {p && !p.exists && <div className="fileindex-preview__missing">This file no longer exists.</div>}
    </div>
  );
}
