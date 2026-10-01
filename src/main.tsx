import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
