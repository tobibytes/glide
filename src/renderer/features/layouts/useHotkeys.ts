import { useEffect, useState } from "react";
import { glide } from "../../lib/glide";

/** item id → accelerator, kept in sync with user data. */
export function useHotkeys(): Record<string, string> {
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({});
  useEffect(() => {
    void glide()
      .getData()
      .then((d) => setHotkeys(d.hotkeys ?? {}));
    return glide().onDataChanged((d) => setHotkeys(d.hotkeys ?? {}));
  }, []);
  return hotkeys;
}
