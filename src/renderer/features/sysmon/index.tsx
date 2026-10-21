import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { SysmonView } from "./SysmonView";
import "./style.css";

export const ui: FeatureUI = {
  views: { monitor: SysmonView as ComponentType<ViewProps> },
};
