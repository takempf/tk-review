import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installExternalLinks } from "./lib/externalLinks";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

installExternalLinks();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
