import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SignIn } from "./sign-in";
import { Thread } from "./thread";
import "./index.css";

function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json() as Promise<{ signedIn: boolean }>)
      .then((me) => setSignedIn(me.signedIn))
      .catch(() => setSignedIn(false));
  }, []);
  if (signedIn === null) return null;
  return signedIn ? <Thread /> : <SignIn />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
