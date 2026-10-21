/** Shows a rendered snippet with the {cursor} position marked; HTML (already sanitised in main) in a styled box. */
import type { Rendered } from "../quicklinks/api";

export function RenderedPreview({ rendered, label }: { rendered: Rendered; label?: string }) {
  const { text, cursorLeft } = rendered;
  const chars = [...text];
  // cursorLeft counts graphemes; code points are close enough for a visual marker.
  const at = cursorLeft > 0 ? Math.max(0, chars.length - cursorLeft) : -1;
  return (
    <div className="snpreview" data-sn-preview>
      {label && <div className="snpreview__label">{label}{cursorLeft > 0 ? ` · caret ${cursorLeft} ← from the end` : ""}</div>}
      {rendered.html ? (
        <div className="snpreview__html" dangerouslySetInnerHTML={{ __html: rendered.html }} />
      ) : (
        <pre className="snpreview__text">
          {at >= 0 ? (
            <>
              {chars.slice(0, at).join("")}
              <span className="snpreview__caret" aria-label="cursor" />
              {chars.slice(at).join("")}
            </>
          ) : (
            text || " "
          )}
        </pre>
      )}
    </div>
  );
}
