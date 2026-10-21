import { LocalStorage } from "@raycast/api";

export interface Note {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  priority: string;
  due: string | null;
  tags: string[];
}

export async function loadNotes(): Promise<Note[]> {
  const raw = await LocalStorage.getItem<string>("notes");
  return raw ? (JSON.parse(raw) as Note[]) : [];
}

export async function saveNotes(notes: Note[]) {
  await LocalStorage.setItem("notes", JSON.stringify(notes));
}
