import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { tr, uiLocale } from "../shared/ui-language.js";

document.documentElement.lang = uiLocale;
document.title = tr("拼好汉化");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
