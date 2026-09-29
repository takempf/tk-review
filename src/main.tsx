import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installExternalLinks } from "./lib/externalLinks";
import { installZoom } from "./lib/zoom";
import { Root } from "./Root";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

installZoom();
installExternalLinks();

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
