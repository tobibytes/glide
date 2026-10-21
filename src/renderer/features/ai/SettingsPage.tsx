/** Settings → AI: API key (stored encrypted in main), model, effort and AI Commands. */
import { useCallback, useEffect, useState } from "react";
import { Field, Group, Row } from "../../components/form";
import { ai, type AiCommandDef, type AiSettings, type KeyStatus, type ModelInfo, type TestResult } from "./api";

const EMPTY_CMD: AiCommandDef = { id: "", name: "", icon: "🤖", prompt: "Rewrite the text below …\n\n<text>\n{selection}\n</text>", replaces: false };

export function AiSettingsPage() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [builtins, setBuiltins] = useState<AiCommandDef[]>([]);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ index: number; cmd: AiCommandDef } | null>(null);

  const load = useCallback(async () => {
    const [st, s, ms, cmds] = await Promise.all([ai.hasApiKey(), ai.getSettings(), ai.listModels(), ai.listCommands()]);
    setStatus(st);
    setSettings(s);
    setModels(ms);
    setBuiltins(cmds.filter((c) => c.builtin));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveKey = async () => {
    setBusy(true);
    setError(null);
    setTest(null);
    try {
      setStatus(await ai.setApiKey(keyInput));
      setKeyInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    if (!confirm("Remove the saved API key?")) return;
    setStatus(await ai.clearApiKey());
    setTest(null);
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      setTest(await ai.testConnection(settings?.model));
    } finally {
      setBusy(false);
    }
  };

  const patch = async (p: Partial<AiSettings>) => setSettings(await ai.setSettings(p));

  const saveCommand = async () => {
    if (!editing || !settings) return;
    const list = [...settings.customCommands];
    if (editing.index < 0) list.push(editing.cmd);
    else list[editing.index] = editing.cmd;
    if (!editing.cmd.name.trim() || !editing.cmd.prompt.trim()) return setError("A command needs a name and a prompt");
    setError(null);
    await patch({ customCommands: list });
    setEditing(null);
  };

  const deleteCommand = async (index: number) => {
    if (!settings || !confirm(`Delete “${settings.customCommands[index]?.name}”?`)) return;
    await patch({ customCommands: settings.customCommands.filter((_, i) => i !== index) });
    setEditing(null);
  };

  if (!settings || !status) return <div className="page">Loading…</div>;

  return (
    <div className="page ai-settings" data-testid="ai-settings">
      <p className="page__lead">Glide uses Claude through your own Anthropic API key. Requests go straight from this Mac to the Anthropic API.</p>
      {error && <div className="error-banner">{error}</div>}

      <Group
        title="API Key"
        footer={
          status.encryptionAvailable
            ? "The key is encrypted with macOS keychain-backed storage and is never shown again or sent to Glide's windows."
            : "Secure storage is unavailable on this system, so a key can't be saved."
        }
      >
        <Row label="Status">
          <span className={status.hasKey ? "ai-badge ai-badge--ok" : "ai-badge"} data-testid="ai-key-status">
            {status.hasKey ? "Key saved" : "No key"}
          </span>
        </Row>
        <Row label={status.hasKey ? "Replace key" : "Anthropic API key"} hint="Create one at console.anthropic.com → API Keys">
          <form
            className="ai-keyform"
            onSubmit={(e) => {
              e.preventDefault();
              if (keyInput.trim()) void saveKey();
            }}
          >
            <input className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} aria-label="API key" />
            <button type="submit" className="btn btn--primary" disabled={busy || !keyInput.trim()}>
              Save
            </button>
          </form>
        </Row>
        <Row label="Connection" hint="Checks the key with the Models API — no tokens are used">
          <div className="ai-keyform">
            <button type="button" className="btn" onClick={() => void runTest()} disabled={busy || !status.hasKey}>
              Test Connection
            </button>
            {status.hasKey && (
              <button type="button" className="btn btn--danger" onClick={() => void removeKey()}>
                Remove Key
              </button>
            )}
          </div>
        </Row>
        {test && (
          <div className={`ai-test ${test.ok ? "ai-test--ok" : "ai-test--fail"}`} role="status" data-testid="ai-test-result">
            {test.ok ? "✓" : "✕"} {test.message}
          </div>
        )}
      </Group>

      <Group title="Model">
        <Row label="Default model" hint={models.find((m) => m.id === settings.model)?.description}>
          <select className="input" value={settings.model} onChange={(e) => void patch({ model: e.target.value })} aria-label="Default model">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.description}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Effort" hint="Lower is faster and cheaper; higher thinks harder">
          <select className="input" value={settings.effort} onChange={(e) => void patch({ effort: e.target.value as AiSettings["effort"] })} aria-label="Effort">
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </Row>
      </Group>

      <Group title="Your AI Commands" footer={<>Use <code>{"{selection}"}</code> for the selected text and <code>{"{argument}"}</code> for text typed after Tab in the launcher.</>}>
        {settings.customCommands.length === 0 && !editing && <div className="ai-settings__empty">No custom commands yet.</div>}
        {settings.customCommands.map((c, i) => (
          <Row key={c.id} label={`${c.icon} ${c.name}`} hint={c.prompt.slice(0, 90)}>
            <div className="ai-keyform">
              <button type="button" className="btn" onClick={() => setEditing({ index: i, cmd: { ...c } })}>
                Edit
              </button>
              <button type="button" className="btn btn--danger" onClick={() => void deleteCommand(i)}>
                Delete
              </button>
            </div>
          </Row>
        ))}
        {!editing && (
          <div className="ai-settings__add">
            <button type="button" className="btn btn--primary" onClick={() => setEditing({ index: -1, cmd: { ...EMPTY_CMD } })}>
              New AI Command
            </button>
          </div>
        )}
        {editing && (
          <form
            className="form ai-cmdform"
            onSubmit={(e) => {
              e.preventDefault();
              void saveCommand();
            }}
            onKeyDown={(e) => {
              if (e.metaKey && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void saveCommand();
              } else if (e.key === "Escape") setEditing(null);
            }}
          >
            <div className="form__grid">
              <Field label="Icon (emoji)" htmlFor="ai-cmd-icon">
                <input id="ai-cmd-icon" className="input" value={editing.cmd.icon} onChange={(e) => setEditing({ ...editing, cmd: { ...editing.cmd, icon: e.target.value } })} />
              </Field>
              <Field label="Name" htmlFor="ai-cmd-name">
                <input id="ai-cmd-name" className="input" autoFocus value={editing.cmd.name} placeholder="Rewrite as Haiku" onChange={(e) => setEditing({ ...editing, cmd: { ...editing.cmd, name: e.target.value } })} />
              </Field>
            </div>
            <Field label="Prompt" htmlFor="ai-cmd-prompt" hint="{selection} = selected text, {argument} = typed argument">
              <textarea id="ai-cmd-prompt" className="input mono ai-cmdform__prompt" rows={7} value={editing.cmd.prompt} onChange={(e) => setEditing({ ...editing, cmd: { ...editing.cmd, prompt: e.target.value } })} />
            </Field>
            <div className="form__grid">
              <Field label="Model" htmlFor="ai-cmd-model">
                <select id="ai-cmd-model" className="input" value={editing.cmd.model ?? ""} onChange={(e) => setEditing({ ...editing, cmd: { ...editing.cmd, model: e.target.value || undefined } })}>
                  <option value="">Default model</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Result">
                <label className="check">
                  <input type="checkbox" checked={!!editing.cmd.replaces} onChange={(e) => setEditing({ ...editing, cmd: { ...editing.cmd, replaces: e.target.checked } })} />
                  Offer “Replace Selection”
                </label>
              </Field>
            </div>
            <div className="form__actions">
              <div />
              <div>
                <button type="button" className="btn" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary">
                  Save Command ⌘S
                </button>
              </div>
            </div>
          </form>
        )}
      </Group>

      <Group title="Built-in AI Commands" footer="Select text in any app, open Glide and run a command. Without a selection the clipboard text is used.">
        {builtins.map((c) => (
          <Row key={c.id} label={`${c.icon} ${c.name}`} hint={c.replaces ? "Can replace the selection" : undefined}>
            <span className="ai-settings__kind">{c.acceptsArgument ? "Tab → argument" : "Built-in"}</span>
          </Row>
        ))}
      </Group>
    </div>
  );
}
