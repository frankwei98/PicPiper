import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";
import { syncSystemTheme } from "./theme";
import { MiniPage } from "./features/mini/MiniPage";

syncSystemTheme();
const isMini = new URLSearchParams(window.location.search).get("mini") === "1";
if (isMini) document.documentElement.classList.add("mini-window");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isMini ? <MiniPage /> : <App />}
  </React.StrictMode>,
);
