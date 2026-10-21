/**
 * Launcher view "agent.history": saved Glide Agent conversations, filtered by the search field.
 * ⏎ resumes one (its context comes along), ⌃X deletes it, ⌘K for more.
 */
import { useCallback, useEffect, useState } from "react";
import { NavList } from "../../components/NavList";
import type { NavAction, NavItem, ViewProps } from "../types";
import { agent, type ConversationSummary } from "./api";

type Row = NavItem & { c: ConversationSummary };

function when(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function HistoryView(view: ViewProps) {
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const query = view.query;

  const refresh = useCallback(async () => setList(await agent.listConversations(query)), [query]);

  useEffect(() => {
    view.setPlaceholder("Search agent conversations…");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 60);
    return () => clearTimeout(t);
  }, [refresh]);

  useEffect(
    () =>
      window.glide.onFeatureEvent((e) => {
        if (e.feature === "agent" && e.event === "conversations") void refresh();
      }),
    [refresh],
  );

  const resume = useCallback((c: ConversationSummary) => view.push({ id: "agent.run", props: { conversationId: c.id } }), [view]);

  const remove = useCallback(
    async (c: ConversationSummary) => {
      await agent.deleteConversation(c.id);
      view.toast(`Deleted “${c.title}”`);
      await refresh();
    },
    [refresh, view],
  );

  const actions = useCallback(
    (row: Row): NavAction[] => [
      { id: "resume", title: "Resume Conversation", shortcut: "⏎", icon: "↩", run: () => resume(row.c) },
      { id: "delete", title: "Delete Conversation", shortcut: "⌃X", icon: "🗑", destructive: true, run: () => void remove(row.c) },
      {
        id: "clear",
        title: "Delete All Conversations",
        icon: "🧹",
        destructive: true,
        run: async () => {
          const n = await agent.clearHistory();
          view.toast(`Deleted ${n} conversation${n === 1 ? "" : "s"}`);
          await refresh();
        },
      },
      { id: "settings", title: "Agent Settings…", icon: "⚙️", run: () => window.glide.openSettings("agent") },
    ],
    [refresh, remove, resume, view],
  );

  const rows: Row[] = (list ?? []).map((c) => ({ id: c.id, c }));

  return (
    <div className="agent agent-history" data-testid="agent-history">
      <NavList<Row>
        items={rows}
        emptyText={list === null ? "Loading…" : query ? "No conversations match" : "No conversations yet — ask Glide Agent something"}
        renderItem={(row, selected) => (
          <div className={`row ${selected ? "row--selected" : ""}`} data-testid="agent-history-row" data-id={row.c.id}>
            <span className="agent-row__icon">🪄</span>
            <div className="row__main">
              <div className="row__title">{row.c.title}</div>
              <div className="row__subtitle">
                {row.c.runs} request{row.c.runs === 1 ? "" : "s"}
                {row.c.preview && row.c.preview !== row.c.title ? ` · last: ${row.c.preview}` : ""}
              </div>
            </div>
            <span className="agent-history__when">{when(row.c.updatedAt)}</span>
          </div>
        )}
        onActivate={(row) => resume(row.c)}
        actions={actions}
        actionsTitle="Conversation"
      />
    </div>
  );
}
