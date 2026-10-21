import { useEffect } from "react";
import { useHashRoute } from "./hooks/useHashRoute";
import { useUserData } from "./hooks/useUserData";
import { useTheme } from "./hooks/useTheme";
import { Launcher } from "./screens/launcher/Launcher";
import { Settings } from "./screens/settings/Settings";
import { resolveWindow } from "./features/registry";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useAppearance } from "./features/appearance/useAppearance";
import type { Settings as SettingsData } from "@shared/types";

/** A stand-alone feature window ("#/<featureId>/<name>"): theme + base styles + the feature's component. */
function FeatureWindow({ route, theme }: { route: string; theme: SettingsData["theme"] | undefined }) {
  useTheme(theme);
  const Comp = resolveWindow(route);
  useEffect(() => {
    document.body.dataset.window = route;
  }, [route]);
  if (!Comp) return <div className="feature-window feature-window--missing">Unknown window “{route}”</div>;
  return (
    <ErrorBoundary fallback={(err) => <div className="feature-window feature-window--missing">This window crashed: {err.message}</div>}>
      <Comp />
    </ErrorBoundary>
  );
}

export function App() {
  const route = useHashRoute();
  const { data, reload } = useUserData();
  const mode = route.mode;
  useAppearance(data?.settings);

  useEffect(() => {
    document.body.classList.toggle("mode-launcher", mode === "launcher");
    document.body.classList.toggle("mode-settings", mode === "settings");
    document.body.classList.toggle("mode-window", mode === "window");
  }, [mode]);

  if (route.mode === "launcher") return <Launcher theme={data?.settings.theme} vimMode={data?.settings.vimMode ?? true} />;
  if (route.mode === "window") return <FeatureWindow route={route.route} theme={data?.settings.theme} />;
  return <Settings route={route} data={data} reload={reload} />;
}
