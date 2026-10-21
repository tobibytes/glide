import { memo, useMemo, type ReactNode } from "react";
import type { MetadataEntry } from "../../../extension-api/types";
import { isSafeHref, isSafeImage, parseMarkdown, type Block, type Inline } from "./markdown";
import { ext } from "./api";
import { iconFor } from "../../../extension-api/icons";
import { Icon } from "../../components/Icon";

function openLink(href: string) {
  if (isSafeHref(href)) void ext("openUrl", href).catch(() => undefined);
}

function renderInline(nodes: Inline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return <code key={k}>{n.v}</code>;
      case "strong":
        return <strong key={k}>{renderInline(n.c, `${k}.`)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.c, `${k}.`)}</em>;
      case "br":
        return <br key={k} />;
      case "image":
        return isSafeImage(n.src) ? <img key={k} src={n.src} alt={n.alt} referrerPolicy="no-referrer" loading="lazy" /> : <span key={k}>{n.alt}</span>;
      case "link":
        return isSafeHref(n.href) ? (
          <a
            key={k}
            href={n.href}
            title={n.href}
            onClick={(e) => {
              e.preventDefault();
              openLink(n.href);
            }}
          >
            {renderInline(n.c, `${k}.`)}
          </a>
        ) : (
          <span key={k}>{renderInline(n.c, `${k}.`)}</span>
        );
    }
  });
}

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.t) {
    case "heading": {
      const H = `h${Math.min(6, b.level)}` as "h1";
      return <H key={i}>{renderInline(b.c)}</H>;
    }
    case "paragraph":
      return <p key={i}>{renderInline(b.c)}</p>;
    case "list":
      return b.ordered ? (
        <ol key={i} start={b.start}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>
      ) : (
        <ul key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre key={i} data-lang={b.lang || undefined}>
          <code>{b.v}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={i}>{b.c.map(renderBlock)}</blockquote>;
    case "hr":
      return <hr key={i} />;
  }
}

export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className="extensions-md">{blocks.map(renderBlock)}</div>;
});

export function Metadata({ entries, assetsPath }: { entries: MetadataEntry[]; assetsPath?: string }) {
  if (!entries.length) return null;
  return (
    <dl className="extensions-meta">
      {entries.map((m, i) => {
        if (m.kind === "separator") return <hr key={i} className="extensions-meta__sep" />;
        return (
          <div key={i} className="extensions-meta__row">
            <dt>{m.label}</dt>
            <dd style={m.color ? { color: m.color } : undefined}>
              {m.icon && <Icon icon={iconFor(m.icon, assetsPath)} />}
              {m.kind === "tags" && m.tags ? (
                <span className="extensions-meta__tags">
                  {m.tags.map((t, j) => (
                    <span key={j} className="tag extensions-tag" style={t.color ? { color: t.color, borderColor: t.color } : undefined}>
                      {t.icon && <Icon icon={iconFor(t.icon, assetsPath)} />}
                      {t.text}
                    </span>
                  ))}
                </span>
              ) : m.link && isSafeHref(m.link) ? (
                <a
                  href={m.link}
                  onClick={(e) => {
                    e.preventDefault();
                    openLink(m.link!);
                  }}
                >
                  {m.text}
                </a>
              ) : (
                m.text
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
