import { Clipboard, LaunchProps, showHUD } from "@raycast/api";

export default async function Command(props: LaunchProps<{ arguments: { fruit: string } }>) {
  const name = props.arguments.fruit.trim();
  await Clipboard.copy(`🍽️ ${name}`);
  await showHUD(`Copied ${name}`);
}
