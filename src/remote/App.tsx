import { useEffect, useState } from "react";
import { useRemoteState } from "./hooks/useRemoteState";
import { ClickTabIcon, MarkLogoIcon, PadsTabIcon } from "./components/icons";
import { PadsTab, type PadStyle } from "./components/PadsTab";
import { ClickTab } from "./components/ClickTab";

type Tab = "pads" | "click";

const STYLE_KEY = "worshippads.remote.padStyle";
const TAB_KEY = "worshippads.remote.tab";

function loadPadStyle(): PadStyle {
  const v = localStorage.getItem(STYLE_KEY);
  return v === "piano" ? "piano" : "grid";
}
function loadTab(): Tab {
  const v = localStorage.getItem(TAB_KEY);
  return v === "click" ? "click" : "pads";
}

export default function App() {
  const { info, now, conn } = useRemoteState();
  const [tab, setTab] = useState<Tab>(loadTab);
  const [padStyle, setPadStyle] = useState<PadStyle>(loadPadStyle);

  useEffect(() => {
    localStorage.setItem(TAB_KEY, tab);
  }, [tab]);
  useEffect(() => {
    localStorage.setItem(STYLE_KEY, padStyle);
  }, [padStyle]);

  return (
    <>
      <header>
        <span className="mark" aria-hidden>
          <MarkLogoIcon />
        </span>
        <h1>Worship Pads</h1>
        <span
          className={`status${conn === "reconnecting" ? " reconnecting" : ""}`}
          title="connection"
        />
      </header>

      <div className="tab-bar" role="tablist">
        <button
          type="button"
          role="tab"
          className={tab === "pads" ? "on" : ""}
          onClick={() => setTab("pads")}
        >
          <PadsTabIcon />
          <span className="tab-label">Pads</span>
        </button>
        <button
          type="button"
          role="tab"
          className={tab === "click" ? "on" : ""}
          onClick={() => setTab("click")}
        >
          <ClickTabIcon />
          <span className="tab-label">Click</span>
        </button>
      </div>

      {tab === "pads" ? (
        <PadsTab info={info} now={now} padStyle={padStyle} onPadStyle={setPadStyle} />
      ) : (
        <ClickTab now={now} />
      )}
    </>
  );
}
