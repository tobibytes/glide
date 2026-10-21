import type { FeatureUI } from "../types";
import { OnboardingWindow } from "./OnboardingWindow";
import "./style.css";

export const ui: FeatureUI = {
  windows: { welcome: OnboardingWindow },
};
