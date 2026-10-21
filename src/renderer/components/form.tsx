import type { ReactNode } from "react";

/** Grouped settings rows, macOS System Settings style. */
export function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="group">
      {title && <h3 className="group__title">{title}</h3>}
      <div className="group__box">{children}</div>
      {footer && <p className="group__footer">{footer}</p>}
    </section>
  );
}

export function Row({ label, hint, children, align = "center", htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; align?: "center" | "start"; htmlFor?: string }) {
  return (
    <div className={`row row--${align}`}>
      <div className="row__label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint && <div className="row__hint">{hint}</div>}
      </div>
      <div className="row__control">{children}</div>
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

export function Stepper({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="stepper">
      <input className="input stepper__input" type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(clamp(Number(e.target.value) || min))} />
      <div className="stepper__btns">
        <button type="button" aria-label="Increase" onClick={() => onChange(clamp(value + step))}>
          ▴
        </button>
        <button type="button" aria-label="Decrease" onClick={() => onChange(clamp(value - step))}>
          ▾
        </button>
      </div>
    </div>
  );
}

export function Field({ label, children, hint, htmlFor }: { label: string; children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}
