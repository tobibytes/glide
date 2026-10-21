import { Action, ActionPanel, Alert, Icon, List, confirmAlert, showToast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { loadNotes, saveNotes } from "./storage";

export default function Command() {
  const { data: notes, isLoading, revalidate } = usePromise(loadNotes, []);
  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search notes…">
      <List.EmptyView title="No notes yet" description="Create one with New Quick Note" icon={Icon.Document} />
      {(notes ?? []).map((n) => (
        <List.Item
          key={n.id}
          id={n.id}
          title={n.title}
          subtitle={n.body}
          icon={n.pinned ? Icon.Pin : Icon.Document}
          accessories={[{ tag: n.priority }, ...n.tags.map((t) => ({ text: `#${t}` }))]}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard title="Copy Note" content={`${n.title}\n\n${n.body}`} />
              <Action
                title="Delete Note"
                style={Action.Style.Destructive}
                icon={Icon.Trash}
                shortcut={{ modifiers: ["ctrl"], key: "x" }}
                onAction={async () => {
                  const ok = await confirmAlert({ title: `Delete "${n.title}"?`, message: "This cannot be undone.", primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive } });
                  if (!ok) return;
                  await saveNotes((notes ?? []).filter((x) => x.id !== n.id));
                  await showToast({ title: "Deleted" });
                  revalidate();
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
