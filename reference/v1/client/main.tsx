import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SignIn } from "./sign-in";
import { Thread } from "./thread";
import "./index.css";

function App() {
  const [me, setMe] = useState<{ configured: boolean; signedIn: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json() as Promise<{ configured: boolean; signedIn: boolean }>)
      .then(setMe)
      .catch(() => setMe({ configured: false, signedIn: false }));
  }, []);
  if (me === null) return null;
  return me.signedIn ? <Thread /> : <SignIn configured={me.configured} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
