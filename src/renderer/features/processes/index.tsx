import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { PortsView } from "./PortsView";
import { ProcessesView } from "./ProcessesView";
import "./style.css";

export const ui: FeatureUI = {
  views: {
    list: ProcessesView as ComponentType<ViewProps>,
    ports: PortsView as ComponentType<ViewProps>,
  },
};
