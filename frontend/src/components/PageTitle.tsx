import { useEffect } from "react";
import { useLocation } from "react-router-dom";

export function PageTitle() {
  const location = useLocation();

  useEffect(() => {
    const path = location.pathname;
    let pageName = "Home";

    if (path === "/") pageName = "Home";
    else if (path === "/events") pageName = "My Events";
    else if (path === "/patrols") pageName = "Race Patrols";
    else if (path === "/help") pageName = "Help";
    else if (path === "/login") pageName = "Login";
    else if (path === "/signup") pageName = "Signup";
    else if (path.startsWith("/kiosk/")) pageName = "Kiosk";
    else if (path.startsWith("/control/")) pageName = "Controller";
    else if (path.startsWith("/configure/")) pageName = "Configure";
    else if (path.startsWith("/events/") && path.endsWith("/scouts")) pageName = "Racers";
    else if (path.startsWith("/results/")) pageName = "Results";
    else if (path.startsWith("/pair/")) pageName = "Pair Device";
    else if (path.startsWith("/guest-kiosk/")) pageName = "Guest Kiosk";

    document.title = `Pinewood Controller - ${pageName}`;
  }, [location.pathname]);

  return null;
}

