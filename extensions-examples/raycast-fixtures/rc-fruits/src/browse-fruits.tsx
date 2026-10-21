import { Action, ActionPanel, Color, Detail, Icon, Keyboard, List, getPreferenceValues, showToast, Toast, useNavigation } from "@raycast/api";
import { useMemo, useState } from "react";
import { FRUITS, TINT, type Fruit } from "./fruits";

interface Preferences {
  greeting: string;
  showPrices: boolean;
  currency: string;
}

function FruitDetail({ fruit }: { fruit: Fruit }) {
  const { greeting } = getPreferenceValues<Preferences>();
  const { pop } = useNavigation();
  return (
    <Detail
      navigationTitle={fruit.name}
      markdown={`# ${fruit.emoji} ${fruit.name}\n\n${greeting}, **${fruit.name}**!`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Origin" text={fruit.origin} icon={Icon.Globe} />
          <Detail.Metadata.TagList title="Colour">
            <Detail.Metadata.TagList.Item text={fruit.color} color={TINT[fruit.color]} />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Separator />
          <Detail.Metadata.Link title="Wiki" text="Wikipedia" target={`https://en.wikipedia.org/wiki/${fruit.name}`} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Fruit Name" content={fruit.name} />
          <Action title="Back to List" icon={Icon.ArrowLeft} onAction={pop} shortcut={{ modifiers: ["cmd"], key: "b" }} />
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const [color, setColor] = useState<string>("all");
  const [showingDetail, setShowingDetail] = useState(false);
  const [eaten, setEaten] = useState<string[]>([]);
  const groups = useMemo(() => {
    const visible = FRUITS.filter((f) => (color === "all" || f.color === color) && !eaten.includes(f.id));
    return (["Red", "Yellow", "Green"] as const).map((c) => ({ color: c, fruits: visible.filter((f) => f.color === c) })).filter((g) => g.fruits.length);
  }, [color, eaten]);

  return (
    <List
      searchBarPlaceholder="Search fruits…"
      isShowingDetail={showingDetail}
      searchBarAccessory={
        <List.Dropdown tooltip="Colour" onChange={setColor}>
          <List.Dropdown.Item title="All Colours" value="all" />
          <List.Dropdown.Section title="Colours">
            <List.Dropdown.Item title="Red" value="Red" />
            <List.Dropdown.Item title="Yellow" value="Yellow" />
            <List.Dropdown.Item title="Green" value="Green" />
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      <List.EmptyView title="No fruit left" description="You ate everything." icon={Icon.Tray} />
      {groups.map((g) => (
        <List.Section key={g.color} title={`${g.color} Fruits`} subtitle={String(g.fruits.length)}>
          {g.fruits.map((fruit) => (
            <List.Item
              key={fruit.id}
              id={fruit.id}
              title={fruit.name}
              subtitle={fruit.origin}
              icon={fruit.emoji}
              keywords={[fruit.origin, fruit.color]}
              accessories={prefs.showPrices ? [{ text: { value: `${prefs.currency === "eur" ? "€" : "$"}${fruit.price.toFixed(2)}`, color: Color.Green } }, { icon: { source: Icon.Circle, tintColor: TINT[fruit.color] } }] : []}
              detail={
                <List.Item.Detail
                  markdown={`## ${fruit.emoji} ${fruit.name}`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="Origin" text={fruit.origin} />
                      <List.Item.Detail.Metadata.Label title="Price" text={fruit.price.toFixed(2)} />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel title={fruit.name}>
                  <Action.Push title="Show Fruit" icon={Icon.Eye} target={<FruitDetail fruit={fruit} />} />
                  <Action title={showingDetail ? "Hide Details" : "Show Details"} icon={Icon.Sidebar} onAction={() => setShowingDetail((s) => !s)} shortcut={{ modifiers: ["cmd"], key: "d" }} />
                  <ActionPanel.Section title="Manage">
                    <Action.CopyToClipboard title="Copy Name" content={fruit.name} shortcut={Keyboard.Shortcut.Common.Copy} />
                    <Action
                      title="Eat Fruit"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={Keyboard.Shortcut.Common.Remove}
                      onAction={async () => {
                        setEaten((e) => [...e, fruit.id]);
                        await showToast({ style: Toast.Style.Success, title: `Ate ${fruit.name}` });
                      }}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}
