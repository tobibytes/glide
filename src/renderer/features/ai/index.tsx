import type { FeatureUI } from "../types";
import { ChatWindow } from "./ChatWindow";
import { QuickAI } from "./QuickAI";
import { AiSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: { chat: QuickAI },
  settingsPage: { title: "AI", icon: "✨", component: AiSettingsPage },
  windows: { chat: ChatWindow },
};
