/** Renders a glyph shortcut ("⇧⌘C", "⌘K", "⏎") as one or more key caps. */
export function Kbd({ keys, className = "" }: { keys: string; className?: string }) {
  const parts = keys.includes(" ") ? keys.split(" ") : [keys];
  return (
    <span className={`kbd-group ${className}`.trim()} aria-label={keys}>
      {parts.map((p, i) => (
        <kbd key={i} className="kbd">
          {p}
        </kbd>
      ))}
    </span>
  );
}
