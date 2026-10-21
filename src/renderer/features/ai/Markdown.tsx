/** Renders the safe Markdown AST (mdparse.ts) with React elements only — never innerHTML. */
import { memo, useMemo, useState, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./mdparse";

function openLink(href: string) {
  void window.glide?.feature("ai", "openUrl", href);
}

function inlines(list: Inline[], key = ""): ReactNode[] {
  return list.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "text":
        return n.v;
      case "br":
        return <br key={k} />;
      case "code":
        return (
          <code key={k} className="ai-md__icode">
            {n.v}
          </code>
        );
      case "strong":
        return <strong key={k}>{inlines(n.c, `${k}.`)}</strong>;
      case "em":
        return <em key={k}>{inlines(n.c, `${k}.`)}</em>;
      case "del":
        return <del key={k}>{inlines(n.c, `${k}.`)}</del>;
      case "link":
        return (
          <a
            key={k}
            href={n.href}
            title={n.href}
            onClick={(e) => {
              e.preventDefault();
              openLink(n.href);
            }}
          >
            {inlines(n.c, `${k}.`)}
          </a>
        );
    }
  });
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ai-md__code">
      <div className="ai-md__codebar">
        <span>{lang || "code"}</span>
        <button
          type="button"
          className="ai-md__copy"
          onClick={() => {
            void window.glide?.feature("ai", "copy", code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function blocks(list: Block[], key = ""): ReactNode[] {
  return list.map((b, i) => {
    const k = `${key}${i}`;
    switch (b.t) {
      case "heading": {
        const H = (`h${Math.min(6, b.level + 2)}` as "h3" | "h4" | "h5" | "h6");
        return (
          <H key={k} className="ai-md__h">
            {inlines(b.c)}
          </H>
        );
      }
      case "para":
        return <p key={k}>{inlines(b.c)}</p>;
      case "code":
        return <CodeBlock key={k} lang={b.lang} code={b.v} />;
      case "hr":
        return <hr key={k} />;
      case "quote":
        return <blockquote key={k}>{blocks(b.c, `${k}.`)}</blockquote>;
      case "list": {
        const items = b.items.map((it, j) => (
          <li key={j} className={it.checked !== undefined ? "ai-md__task" : undefined}>
            {it.checked !== undefined && <span className="ai-md__check">{it.checked ? "☑" : "☐"}</span>}
            {inlines(it.c)}
            {it.children && blocks(it.children, `${k}.${j}.`)}
          </li>
        ));
        return b.ordered ? (
          <ol key={k} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
    }
  });
}

export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const ast = useMemo(() => parseMarkdown(text), [text]);
  return <div className={`ai-md ${className}`.trim()}>{blocks(ast)}</div>;
});
