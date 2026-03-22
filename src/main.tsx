import React from "react";
import ReactDOM from "react-dom/client";

const pathname = window.location.pathname;
const isOverlay = pathname === "/overlay";

if (isOverlay) {
  // Overlay: no App.css, only Overlay styles
  import("./components/Overlay").then(({ default: Overlay }) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <Overlay />
      </React.StrictMode>
    );
  });
} else {
  // Main app
  import("./App.css");
  import("./App").then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  });
}
