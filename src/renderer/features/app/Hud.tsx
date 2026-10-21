import { useEffect, useState } from "react";
import { glide } from "../../lib/glide";

/** Window route "app/hud": a pill of text driven by main (hud:show / hud:hide). */
export function Hud() {
  const [text, setText] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("app-hud-root");
    const off = glide().onFeatureEvent((e) => {
      if (e.feature !== "app") return;
      if (e.event === "hud:show" && typeof e.payload === "string") {
        setText(e.payload);
        setVisible(true);
      } else if (e.event === "hud:hide") setVisible(false);
    });
    return () => {
      off();
      document.documentElement.classList.remove("app-hud-root");
    };
  }, []);

  return (
    <div className="app-hud" aria-live="polite">
      <div className={`app-hud__pill ${visible ? "app-hud__pill--on" : ""}`}>{text}</div>
    </div>
  );
}
