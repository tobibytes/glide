import { useEffect, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { call, errorText, type OcrSettingsState } from "./api";

const LANGS: Array<[string, string]> = [
  ["", "Automatic"],
  ["en-US", "English"],
  ["fr-FR", "French"],
  ["de-DE", "German"],
  ["es-ES", "Spanish"],
  ["it-IT", "Italian"],
  ["pt-BR", "Portuguese"],
  ["zh-Hans", "Chinese (Simplified)"],
  ["zh-Hant", "Chinese (Traditional)"],
  ["ja-JP", "Japanese"],
  ["ko-KR", "Korean"],
  ["ru-RU", "Russian"],
  ["uk-UA", "Ukrainian"],
  ["ar-SA", "Arabic"],
];

const ACCESS: Record<string, string> = {
  granted: "Granted",
  denied: "Denied — enable Glide in System Settings, then reopen Glide",
  restricted: "Restricted by your administrator",
  "not-determined": "Not asked yet — macOS asks on the first capture",
  unknown: "Unknown",
};

export function OcrSettingsPage() {
  const [s, setS] = useState<OcrSettingsState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => void call<OcrSettingsState>("settings").then(setS, (e: unknown) => setErr(errorText(e))), []);
  if (!s) return <div className="page">{err ?? "Loading…"}</div>;
  const save = (patch: Partial<OcrSettingsState>) => void call<OcrSettingsState>("setSettings", patch).then(setS);

  return (
    <div className="page">
      <p className="page__lead">“Capture Text” lets you drag over any part of the screen and copies the text it finds (Apple Vision, on device). “Scan QR Code” reads QR codes and barcodes the same way. Both also work on an image you copied.</p>
      {!s.helper && <div className="error-banner">The Glide helper is not running, so text recognition is unavailable.</div>}
      <Group title="Recognition">
        <Row label="Copy text automatically" hint="Put recognized text on the clipboard right after a capture">
          <Toggle label="Copy text automatically" checked={s.autoCopy} onChange={(v) => save({ autoCopy: v })} />
        </Row>
        <Row label="Language correction" hint="Fixes likely misreadings using a language model; turn off for code or serial numbers">
          <Toggle label="Language correction" checked={s.languageCorrection} onChange={(v) => save({ languageCorrection: v })} />
        </Row>
        <Row label="Fast mode" hint="Lower accuracy, quicker on large captures">
          <Toggle label="Fast mode" checked={s.fast} onChange={(v) => save({ fast: v })} />
        </Row>
        <Row label="Language">
          <select className="select" value={s.languages[0] ?? ""} onChange={(e) => save({ languages: e.target.value ? [e.target.value] : [] })}>
            {LANGS.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group title="Permission" footer="Without Screen Recording, captures of other apps' windows come out blank. Temporary capture images are deleted right after recognition.">
        <Row label="Screen Recording" hint={ACCESS[s.screenAccess] ?? s.screenAccess}>
          <button type="button" className="btn btn--sm" onClick={() => void call("openScreenRecordingSettings")}>
            Open Settings…
          </button>
        </Row>
      </Group>
    </div>
  );
}
