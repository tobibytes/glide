import { useCallback, useEffect, useState } from "react";
import type { UserData } from "@shared/types";
import { glide } from "../lib/glide";

/** Loads UserData once and follows evt:dataChanged. */
export function useUserData(): { data: UserData | null; reload: () => Promise<void>; error: string | null } {
  const [data, setData] = useState<UserData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await glide().getData());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void reload();
    return glide().onDataChanged((next) => setData(next));
  }, [reload]);
  return { data, reload, error };
}
