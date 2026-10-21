import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { MenuSearchView } from "./MenuSearchView";
import "./style.css";

export const ui: FeatureUI = {
  views: { search: MenuSearchView as ComponentType<ViewProps> },
};
