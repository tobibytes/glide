import { AI, Detail, environment } from "@raycast/api";
import { useAI } from "@raycast/utils";

export default function Command() {
  const { data, isLoading } = useAI("Say hello to Glide", { creativity: "low" });
  return <Detail isLoading={isLoading} markdown={`canAccess=${environment.canAccess(AI)}\n\n${data}`} />;
}
