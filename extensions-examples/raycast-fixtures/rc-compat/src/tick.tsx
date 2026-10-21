import { environment, getPreferenceValues, LaunchProps } from "@raycast/api";
import { record } from "./log";

export default async function Command(props: LaunchProps) {
  const { label } = getPreferenceValues<{ label: string }>();
  record("tick.log", `${environment.launchType} ${props.launchType} ${label}`);
}
