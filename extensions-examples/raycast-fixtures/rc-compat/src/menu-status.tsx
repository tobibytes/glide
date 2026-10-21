import { environment, Icon, LocalStorage, MenuBarExtra } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { record } from "./log";

export default function Command() {
  const { data: count, isLoading, revalidate } = usePromise(async () => Number((await LocalStorage.getItem<number>("count")) ?? 0));
  if (!isLoading) record("menu.log", `render ${environment.launchType} ${count}`);
  return (
    <MenuBarExtra icon="🧪" title={isLoading ? undefined : `C${count}`} tooltip="Compat Lab" isLoading={isLoading}>
      <MenuBarExtra.Section title="Counter">
        <MenuBarExtra.Item
          title="Increment"
          icon={Icon.Plus}
          shortcut={{ modifiers: ["cmd"], key: "i" }}
          onAction={async () => {
            await LocalStorage.setItem("count", (count ?? 0) + 1);
            record("menu.log", `increment ${(count ?? 0) + 1}`);
            revalidate();
          }}
        />
        <MenuBarExtra.Item title="Read only" subtitle="no action" />
      </MenuBarExtra.Section>
      <MenuBarExtra.Separator />
      <MenuBarExtra.Submenu title="More" icon={Icon.Ellipsis}>
        <MenuBarExtra.Item title="Say Hi" onAction={() => record("menu.log", "hi")} />
      </MenuBarExtra.Submenu>
    </MenuBarExtra>
  );
}
