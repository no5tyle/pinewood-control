import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./AuthContext";
import { ClaimLocalGuestEventsOnAuth } from "./components/ClaimLocalGuestEventsOnAuth";
import { DonateOverlay } from "./components/DonateOverlay";
import { KioskSessionRefresher } from "./components/KioskSessionRefresher";
import { PageTitle } from "./components/PageTitle";
import { QuickStartOverlay } from "./components/QuickStartOverlay";
import { AddScoutsPage } from "./pages/AddScoutsPage";
import { ConfigurePage } from "./pages/ConfigurePage";
import { EventsPage } from "./pages/EventsPage";
import { GuestKioskRedeemPage } from "./pages/GuestKioskRedeemPage";
import { HelpPage } from "./pages/HelpPage";
import { KioskBootPage } from "./pages/KioskBootPage";
import { KioskPage } from "./pages/KioskPage";
import { LoginPage } from "./pages/LoginPage";
import { PairingPage } from "./pages/PairingPage";
import { RaceControlPage } from "./pages/RaceControlPage";
import { RacePatrolsPage } from "./pages/RacePatrolsPage";
import { ResultsPage } from "./pages/ResultsPage";
import { SignupPage } from "./pages/SignupPage";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <ClaimLocalGuestEventsOnAuth />
        <KioskSessionRefresher />
        <PageTitle />
        <QuickStartOverlay />
        <DonateOverlay />
        <Routes>
          <Route path="/" element={<KioskBootPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/patrols" element={<RacePatrolsPage />} />
          <Route path="/kiosk/:eventId" element={<KioskPage />} />
          <Route path="/guest-kiosk/:token" element={<GuestKioskRedeemPage />} />
          <Route path="/pair/:qrToken" element={<PairingPage />} />
          <Route path="/configure/:token" element={<ConfigurePage />} />
          <Route path="/events/:eventId/scouts" element={<AddScoutsPage />} />
          <Route path="/control/:eventId" element={<RaceControlPage />} />
          <Route path="/results/:eventId" element={<ResultsPage />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
