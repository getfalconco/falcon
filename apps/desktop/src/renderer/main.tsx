import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/geist-sans/300.css";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/playfair-display/400.css";
import "@fontsource/playfair-display/500.css";
import "@fontsource/libre-baskerville/400.css";
import "@fontsource/libre-baskerville/700.css";
import App from "./App";
import BaseHost from "./components/base/BaseHost";
import PropagationHost from "./components/propagation/PropagationHost";
import RiskHost from "./components/risk/RiskHost";
import ScreenHost from "./components/screen/ScreenHost";
import QuantLabHost from "./components/quantlab/QuantLabHost";
import GaugeHost from "./components/gauge/GaugeHost";
import TrackerHost from "./components/tracker/TrackerHost";
import DiagnosticsHost from "./components/diagnostics/DiagnosticsHost";
import "./globals.css";
import { applyTheme, getStoredTheme, watchSystemTheme } from "./lib/theme";

applyTheme(getStoredTheme());
// While the choice is "system", follow the machine for as long as the app runs.
watchSystemTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <TrackerHost />
    <BaseHost />
    <PropagationHost />
    <RiskHost />
    <ScreenHost />
    <QuantLabHost />
    <GaugeHost />
    <DiagnosticsHost />
  </React.StrictMode>,
);
