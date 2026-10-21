/**
 * Launcher views for Raycast compatibility:
 *  - "extensions.createEntry": Action.CreateSnippet / CreateQuicklink — a prefilled form the user confirms (⌘⏎);
 *  - "extensions.oauth": the sign-in card for no-view / menu-bar commands (view commands show it over their view).
 */
import { useEffect, useState } from "react";
import type { FormFieldModel, FormValues } from "../../../extension-api/types";
import type { OAuthRequest } from "../../../main/features/extensions/oauth";
import type { ViewProps } from "../types";
import { errorText, ext } from "./api";
import { FieldsForm } from "./FieldsForm";
import { OAuthCard } from "./Overlays";

const SNIPPET_FIELDS: FormFieldModel[] = [
  { id: "name", title: "Name", type: "text", required: false, options: [], placeholder: "Snippet name" },
  { id: "text", title: "Snippet", type: "textarea", required: true, options: [] },
  { id: "keyword", title: "Keyword", type: "text", required: false, options: [], placeholder: "Optional, e.g. ;sig", info: "Typing the keyword anywhere expands the snippet" },
];

const QUICKLINK_FIELDS: FormFieldModel[] = [
  { id: "name", title: "Name", type: "text", required: false, options: [], placeholder: "Quicklink name" },
  { id: "link", title: "Link", type: "text", required: true, options: [], placeholder: "https://example.com/search?q={query}", info: "{query} is replaced with the text typed after the quicklink" },
];

export function CreateEntryView({ props, setPlaceholder, pop, toast }: ViewProps) {
  const kind = props.kind === "quicklink" ? "quicklink" : "snippet";
  const values = (props.values ?? {}) as Record<string, unknown>;
  const [busy, setBusy] = useState(false);
  useEffect(() => setPlaceholder(""), [setPlaceholder]);
  const fields = (kind === "snippet" ? SNIPPET_FIELDS : QUICKLINK_FIELDS).map((f) => (typeof values[f.id] === "string" ? { ...f, default: values[f.id] as string } : f));
  const submit = async (v: FormValues) => {
    setBusy(true);
    try {
      await ext(kind === "snippet" ? "saveSnippet" : "saveQuicklink", v);
      toast(kind === "snippet" ? "Snippet created" : "Quicklink created");
      pop();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <FieldsForm
      fields={fields}
      busy={busy}
      submitTitle={kind === "snippet" ? "Create Snippet" : "Create Quicklink"}
      description={kind === "snippet" ? "An extension suggested this snippet. Edit it, then ⌘⏎ to save." : "An extension suggested this quicklink. Edit it, then ⌘⏎ to save."}
      onSubmit={submit}
      onCancel={pop}
    />
  );
}

export function OAuthView({ props, setPlaceholder, pop }: ViewProps) {
  const id = String(props.requestId ?? "");
  const [req, setReq] = useState<OAuthRequest | null | undefined>(undefined);
  useEffect(() => {
    setPlaceholder("");
    void ext<OAuthRequest | null>("oauthPrompt", id).then(setReq, () => setReq(null));
  }, [id, setPlaceholder]);
  // The view closes itself once the redirect arrived (or the request was cancelled elsewhere).
  useEffect(() => {
    if (!req) return;
    const t = setInterval(() => {
      void ext<OAuthRequest | null>("oauthPrompt", id).then((r) => {
        if (!r) pop();
      });
    }, 1000);
    return () => clearInterval(t);
  }, [req, id, pop]);
  if (req === undefined) return <div className="extensions-loading"><div className="glide-loading" aria-hidden="true" /></div>;
  if (req === null) return <div className="extensions-loading">This sign-in request is no longer active.</div>;
  return (
    <div className="extensions-run">
      <OAuthCard prompt={{ id: req.id, providerName: req.providerName, providerIcon: req.providerIcon, description: req.description }} onDone={pop} />
    </div>
  );
}
