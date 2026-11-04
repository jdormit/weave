import { RegistryContext } from "@effect/atom-react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./ui/App.tsx"
import { loadSettings, registry } from "./ui/state.ts"

void loadSettings()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryContext.Provider value={registry}>
      <App />
    </RegistryContext.Provider>
  </StrictMode>
)
