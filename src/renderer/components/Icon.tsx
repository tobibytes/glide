import { useState } from "react";
import type { ItemIcon } from "@shared/types";
import { iconUrl, symbolGlyph } from "../lib/icons";

interface Props {
  icon?: ItemIcon;
  size?: "md" | "lg" | "xl";
  fallback?: string;
  className?: string;
}

/** Renders every ItemIcon kind: emoji, symbol, app/file (via glide-icon://), url image, or a color dot. */
export function Icon({ icon, size = "md", fallback = "▢", className = "" }: Props) {
  const [broken, setBroken] = useState(false);
  const cls = `icon icon--${size} ${className}`.trim();
  if (!icon) return <span className={`${cls} icon--symbol`}>{fallback}</span>;
  if (icon.kind === "emoji") return <span className={cls}>{icon.value}</span>;
  if (icon.kind === "color") return <span className={`${cls} icon--color`} style={{ background: icon.value }} aria-hidden="true" />;
  if (icon.kind === "symbol")
    return (
      <span className={`${cls} icon--symbol`} style={icon.tint ? { color: icon.tint } : undefined}>
        {symbolGlyph(icon.value)}
      </span>
    );
  const url = iconUrl(icon);
  if (!url || broken) return <span className={`${cls} icon--symbol`}>{fallback}</span>;
  return (
    <span className={cls}>
      <img src={url} alt="" draggable={false} onError={() => setBroken(true)} />
    </span>
  );
}
