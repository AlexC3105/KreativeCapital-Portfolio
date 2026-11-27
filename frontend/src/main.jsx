import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/cinzel/400.css";
import "@fontsource/cinzel/700.css";
import "./styles/app.css";
import App from "./App.jsx";
import { AppProvider } from "./state/AppProvider.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AppProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppProvider>
  </StrictMode>
);
