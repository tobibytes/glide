/** Tiny dependency-free SVG sparkline. `max` fixes the scale (e.g. 1 for percentages); otherwise it auto-scales. */
export function Sparkline({ values, max, width = 120, height = 28, className = "", label }: { values: number[]; max?: number; width?: number; height?: number; className?: string; label?: string }) {
  const n = values.length;
  const top = max ?? Math.max(1e-9, ...values);
  const pts = values.map((v, i) => {
    const x = n <= 1 ? width : (i / (n - 1)) * width;
    const y = height - 1 - (Math.min(top, Math.max(0, v)) / top) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg className={`sysmon-spark ${className}`.trim()} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? "trend"} preserveAspectRatio="none">
      {n > 1 && (
        <>
          <polygon className="sysmon-spark__area" points={`0,${height} ${pts.join(" ")} ${width},${height}`} />
          <polyline className="sysmon-spark__line" points={pts.join(" ")} fill="none" />
        </>
      )}
    </svg>
  );
}
