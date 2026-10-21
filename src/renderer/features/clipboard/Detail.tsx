import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { clipApi, type ClipSummary } from "./api";
import { formatBytes, looksLikeCode, TYPE_LABEL } from "./format";

const MAX_SHOWN = 50_000;

/** Right-hand preview: full text / image / color / files, then metadata. */
export function Detail({ s }: { s: ClipSummary }) {
  const [text, setText] = useState<string | null>(s.chars <= s.preview.length ? s.preview : null);
  const [img, setImg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setImg(null);
    if (s.type === "image") {
      // Thumbnail first (fast), then the full image for a crisp preview.
      void clipApi.imageDataUrl(s.id).then((u) => live && u && setImg(u));
      const t = setTimeout(() => void clipApi.imageDataUrl(s.id, true).then((u) => live && u && setImg(u)), 250);
      return () => {
        live = false;
        clearTimeout(t);
      };
    }
    if (s.chars > s.preview.length) {
      setText(null);
      void clipApi.get(s.id).then((e) => live && setText(e?.text ?? ""));
    } else setText(s.preview);
    return () => {
      live = false;
    };
  }, [s.id, s.type, s.chars, s.preview]);

  const meta: Array<[string, string]> = [["Content type", TYPE_LABEL[s.type]]];
  if (s.source?.name) meta.push(["Source", s.source.name]);
  meta.push(["Copied", new Date(s.lastCopiedAt).toLocaleString()]);
  if (s.count > 1) meta.push(["First copied", new Date(s.createdAt).toLocaleString()], ["Times copied", String(s.count)]);
  if (s.type === "image" && s.image) meta.push(["Dimensions", `${s.image.width} × ${s.image.height}`], ["Size", formatBytes(s.image.bytes)]);
  else if (s.type === "file") meta.push(["Files", String(s.files?.length ?? 0)]);
  else meta.push(["Characters", s.chars.toLocaleString()], ["Words", s.words.toLocaleString()]);

  return (
    <div className="clipboard-detail">
      <div className="clipboard-detail__body">
        {s.type === "image" && (img ? <img className="clipboard-detail__image" src={img} alt={s.title} /> : <div className="clipboard-detail__loading">Loading image…</div>)}
        {s.type === "color" && (
          <div className="clipboard-detail__color">
            <div className="clipboard-detail__swatch" style={{ background: s.preview.trim() }} />
            <code>{s.preview.trim()}</code>
          </div>
        )}
        {s.type === "file" && (
          <ul className="clipboard-detail__files">
            {(s.files ?? []).map((f) => (
              <li key={f}>
                <Icon icon={{ kind: "file", value: f }} size="lg" fallback="▤" />
                <span title={f}>{f}</span>
              </li>
            ))}
          </ul>
        )}
        {(s.type === "text" || s.type === "link") &&
          (text === null ? (
            <div className="clipboard-detail__loading">Loading…</div>
          ) : (
            <pre className={`clipboard-detail__text ${s.type === "text" && looksLikeCode(text) ? "clipboard-detail__text--mono" : ""}`}>
              {text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}\n… (${(text.length - MAX_SHOWN).toLocaleString()} more characters)` : text}
            </pre>
          ))}
      </div>
      <dl className="clipboard-detail__meta">
        {meta.map(([k, v]) => (
          <div key={k} className="clipboard-detail__metarow">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
