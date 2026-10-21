import type { FeatureUI } from "../types";
import { FloatingNotes } from "./Float";
import { NotesSearch } from "./Search";
import "./style.css";

export const ui: FeatureUI = {
  views: { search: NotesSearch },
  windows: { float: FloatingNotes },
};
