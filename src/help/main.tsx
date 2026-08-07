import React from "react";
import ReactDOM from "react-dom/client";
import HelpApp from "./HelpApp";
import HelpErrorBoundary from "./HelpErrorBoundary";
import "../styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HelpErrorBoundary>
      <HelpApp />
    </HelpErrorBoundary>
  </React.StrictMode>
);
