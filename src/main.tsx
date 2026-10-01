import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { gitApi } from "./ipc/git";
import { installExternalLinks } from "./lib/externalLinks";
import { installWindowScrollLock } from "./lib/windowScroll";
import { installZoom } from "./lib/zoom";
import { Root } from "./Root";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

installZoom();
installExternalLinks();
installWindowScrollLock();
// Whatever the last page load left running has nowhere to deliver its result:
// only a page waiting on a run can save it. Here, not in a component, so a hot
// update in development can't cancel the runs of the page it keeps alive.
void gitApi.abandonAgentRuns();

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
