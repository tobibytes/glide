import { useEffect, useState } from "react";
import { glide } from "../../lib/glide";
import { useTheme } from "../../hooks/useTheme";
import { Kbd } from "../../components/Kbd";
import { focusCall } from "./common";
import { formatClock } from "../../../main/features/focus/machine";
import type { BlockedInfo } from "../../../main/features/focus/types";

/** Full-window reminder shown when a blocked website is open. It does not (and cannot) block the site. */
export function FocusBlocked() {
  const [theme, setTheme] = useState<"system" | "dark" | "light">();
  useTheme(theme);
  const [info, setInfo] = useState<BlockedInfo | null>(null);

  useEffect(() => {
    document.body.classList.add("focus-blocked-body");
    document.title = "Focus reminder";
    void glide().getData().then((d) => setTheme(d.settings.theme));
    void focusCall<BlockedInfo | null>("blockedInfo").then(setInfo);
    const off = glide().onFeatureEvent((e) => {
      if (e.feature === "focus" && e.event === "blocked") setInfo(e.payload as BlockedInfo);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        void focusCall("dismissBlocked");
      } else if (e.key.toLowerCase() === "s" && e.metaKey) {
        e.preventDefault();
        void focusCall("dismissBlocked", 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("focus-blocked-body");
    };
  }, []);

  return (
    <div className="focus-blocked">
      <div className="focus-blocked__emoji">🎯</div>
      <h1>{info?.site ?? "This site"} is on your focus block list</h1>
      {info?.goal ? (
        <p className="focus-blocked__goal">
          You wanted to focus on <b>“{info.goal}”</b>.
        </p>
      ) : (
        <p className="focus-blocked__goal">You’re in a focus session.</p>
      )}
      {info && <p className="focus-blocked__time">{formatClock(info.remainingMs)} left</p>}
      <div className="focus-blocked__btns">
        <button type="button" className="btn btn--primary" autoFocus onClick={() => void focusCall("dismissBlocked")}>
          Back to Work <Kbd keys="⏎" />
        </button>
        <button type="button" className="btn" onClick={() => void focusCall("dismissBlocked", 5)}>
          Allow 5 Minutes <Kbd keys="⌘S" />
        </button>
      </div>
      <p className="focus-blocked__honest">This is a reminder, not enforcement: Glide can’t block websites without admin rights. Close the tab yourself.</p>
    </div>
  );
}
