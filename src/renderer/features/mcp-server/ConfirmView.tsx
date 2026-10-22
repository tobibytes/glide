import { useEffect, useState } from "react";
import { NavList } from "../../components/NavList";
import type { NavAction, NavItem, ViewProps } from "../types";
import { call, errorText, usePending, type PendingRequest } from "./api";

type Choice = "allow" | "always" | "deny";
type Row = NavItem & { choice: Choice };

const ROWS: Row[] = [
  { id: "allow", choice: "allow" },
  { id: "always", choice: "always" },
  { id: "deny", choice: "deny" },
];

function useSecondsLeft(until: number | undefined): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

/** Launcher view "mcp-server.confirm": an MCP client wants to run a state-changing Glide tool. */
export function ConfirmView({ props, setPlaceholder, close, toast }: ViewProps<{ requestId?: string }>) {
  const pending = usePending();
  const [answered, setAnswered] = useState(0);
  useEffect(() => setPlaceholder("Allow this request?"), [setPlaceholder]);
  const req: PendingRequest | undefined = pending?.find((p) => p.id === props.requestId) ?? pending?.[0];
  const left = useSecondsLeft(req?.expiresAt);

  // Hand focus back once every request opened while this view was up has been answered.
  useEffect(() => {
    if (answered > 0 && pending && pending.length === 0) close();
  }, [answered, pending, close]);

  if (!pending) return <div className="empty">Loading…</div>;
  if (!req) return <div className="empty mcp-server-empty">No pending MCP requests. Agents ask here before Glide runs a state-changing tool.</div>;

  const answer = (choice: Choice) =>
    void call<boolean>("respond", req.id, choice).then(
      (ok) => {
        if (!ok) toast("That request already expired", "error");
        setAnswered((n) => n + 1);
      },
      (e: unknown) => toast(errorText(e), "error"),
    );

  const label = (c: Choice) => (c === "allow" ? "Allow Once" : c === "always" ? `Always Allow ${req.toolTitle} for ${req.client}` : "Deny");
  const shortcut = (c: Choice) => (c === "allow" ? "⏎" : c === "always" ? "⌘⏎" : "⌘⌫");
  const actionFor = (r: Row): NavAction => ({ id: r.choice, title: label(r.choice), shortcut: shortcut(r.choice), destructive: r.choice === "deny", run: () => answer(r.choice) });

  return (
    <div className="mcp-server-confirm" role="dialog" aria-label="MCP request">
      <div className="mcp-server-confirm__head">
        <div className="mcp-server-confirm__title">
          MCP request: <strong>{req.client}</strong> wants to {req.toolTitle.toLowerCase()}
        </div>
        <div className="mcp-server-confirm__summary">{req.summary}</div>
        <div className="faint mcp-server-confirm__meta" data-test-dynamic>
          Tool <code>{req.tool}</code> · denied automatically in {left}s{pending.length > 1 ? ` · ${pending.length - 1} more waiting` : ""}
        </div>
      </div>
      <NavList<Row>
        items={ROWS}
        actionsTitle="MCP Request"
        actions={(r) => [actionFor(r), ...ROWS.filter((x) => x !== r).map(actionFor)]}
        onActivate={(r, mods) => answer(mods.cmd ? "always" : r.choice)}
        renderItem={(r, selected) => (
          <div className={`row ${selected ? "row--selected" : ""}`} data-choice={r.choice}>
            <span className="icon icon--md">{r.choice === "deny" ? "✕" : r.choice === "always" ? "✔︎✔︎" : "✔︎"}</span>
            <div className="row__main">
              <span className="row__title">{label(r.choice)}</span>
            </div>
            <div className="row__right">
              <span className="row__kind">{shortcut(r.choice)}</span>
            </div>
          </div>
        )}
      />
    </div>
  );
}
