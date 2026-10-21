import { Clipboard, Icon, MenuBarExtra } from "@raycast/api";
import { FRUITS } from "./fruits";

export default function Command() {
  return (
    <MenuBarExtra icon="🍎" tooltip="Fruit Basket">
      <MenuBarExtra.Section title="Copy a fruit">
        {FRUITS.slice(0, 3).map((f) => (
          <MenuBarExtra.Item key={f.id} title={f.name} icon={Icon.CopyClipboard} onAction={() => Clipboard.copy(f.name)} />
        ))}
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
