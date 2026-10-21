import type { FeatureUI } from "../types";
import { CodesView } from "./CodesView";
import { ResultView } from "./ResultView";
import { OcrSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: { result: ResultView, codes: CodesView },
  settingsPage: { title: "Screen Text & QR", icon: "🔍", component: OcrSettingsPage },
};
