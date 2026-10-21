import { useEffect, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { glide } from "../../lib/glide";
import type { ConvertState } from "../../../main/features/convert";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("convert", method, ...args);

const EXAMPLES = ["5 km in miles", "100f to c", "3 gb in mb", "5 ft 10 in to cm", "100 usd in eur", "€50 to gbp", "5pm london in tokyo", "time in nyc", "days until dec 25", "today + 3 weeks"];

export function ConvertSettingsPage() {
  const [state, setState] = useState<ConvertState | null>(null);
  const [currency, setCurrency] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call<ConvertState>("state").then((s) => {
      setState(s);
      setCurrency(s.settings.defaultCurrency);
    });
    return glide().onFeatureEvent((e) => {
      if (e.feature === "convert" && e.event === "state") setState(e.payload as ConvertState);
    });
  }, []);

  if (!state) return <div className="empty">Loading…</div>;
  const save = async (patch: Record<string, unknown>) => setState(await call<ConvertState>("setSettings", patch));
  const r = state.rates;

  return (
    <div className="page">
      <p className="page__lead">Type conversions straight into the launcher. Results appear in the Calculator section; ⏎ copies, ⌘⏎ pastes, ⌘K shows more copy formats.</p>
      <Group title="Conversions">
        <Row label="Show conversions in search" hint="Units, currency, time zones and dates">
          <Toggle checked={state.settings.enabled} label="Show conversions in search" onChange={(v) => void save({ enabled: v })} />
        </Row>
        <Row label="Examples" align="start">
          <span className="convert-examples">
            {EXAMPLES.map((e) => (
              <code key={e}>{e}</code>
            ))}
          </span>
        </Row>
      </Group>
      <Group
        title="Currency"
        footer="Glide contacts open.er-api.com (falling back to api.frankfurter.app, ECB rates) only after you type a currency query, at most every 6 hours. No account, key or query text is sent. With fetching off, the last downloaded rates are still used."
      >
        <Row label="Fetch exchange rates" hint="Network access to the rates API">
          <Toggle checked={state.settings.currencyNetwork} label="Fetch exchange rates" onChange={(v) => void save({ currencyNetwork: v })} />
        </Row>
        <Row label="Default currency" hint="Target for “$20” or “50 eur” without “in …”">
          <input
            className="input mono convert-currency"
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            onBlur={() => void save({ defaultCurrency: currency })}
            aria-label="Default currency"
          />
        </Row>
        <Row label="Cached rates">
          <span className="faint">{r ? `${r.count} currencies · ${r.source} · published ${r.date} · fetched ${new Date(r.fetchedAt).toLocaleString()}${r.fresh ? "" : " (stale)"}` : "None yet"}</span>
        </Row>
        {state.error && (
          <Row label="Last error">
            <span className="faint">{state.error}</span>
          </Row>
        )}
        <Row label="">
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || !state.settings.currencyNetwork}
            onClick={() => {
              setBusy(true);
              void call<ConvertState>("refreshRates").then((s) => {
                setState(s);
                setBusy(false);
              });
            }}
          >
            {busy ? "Refreshing…" : "Refresh Now"}
          </button>{" "}
          <button type="button" className="btn btn--sm" disabled={!r} onClick={() => void call<ConvertState>("clearRates").then(setState)}>
            Delete Cached Rates
          </button>
        </Row>
      </Group>
    </div>
  );
}
