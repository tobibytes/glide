import { Action, ActionPanel, Icon, List, getPreferenceValues } from "@raycast/api";
import { useFetch } from "@raycast/utils";
import { useState } from "react";

interface Item {
  id: string;
  name: string;
  kind: string;
}

export default function Command() {
  const { baseUrl } = getPreferenceValues<{ baseUrl: string }>();
  const [query, setQuery] = useState("");
  const { data, isLoading, pagination, error } = useFetch(
    (options) => `${baseUrl.replace(/\/$/, "")}/items?q=${encodeURIComponent(query)}&page=${options.page}`,
    {
      mapResult(result: { items: Item[]; hasMore: boolean }) {
        return { data: result.items, hasMore: result.hasMore };
      },
      keepPreviousData: true,
      initialData: [],
    },
  );
  return (
    <List isLoading={isLoading} onSearchTextChange={setQuery} throttle searchBarPlaceholder="Search the server…" pagination={pagination}>
      {error ? <List.EmptyView title="Request failed" description={String(error.message ?? error)} icon={Icon.Warning} /> : null}
      {(data ?? []).map((item) => (
        <List.Item
          key={item.id}
          id={item.id}
          title={item.name}
          subtitle={item.kind}
          icon={Icon.Dot}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard title="Copy Name" content={item.name} />
              <Action.OpenInBrowser url={`${baseUrl.replace(/\/$/, "")}/items/${item.id}`} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
