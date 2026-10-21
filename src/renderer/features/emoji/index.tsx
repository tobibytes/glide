import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { EmojiPicker } from "./Picker";
import "./style.css";

export const ui: FeatureUI = {
  views: { picker: EmojiPicker as ComponentType<ViewProps> },
};
