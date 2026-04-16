import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { donateOpenEventName, quickStartOpenEventName } from "../shared/events";

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10.59 13.41a1 1 0 0 1 0-1.41l3.3-3.3a3 3 0 0 1 4.24 4.24l-2.83 2.83a3.5 3.5 0 0 1-4.95 0 1 1 0 1 1 1.41-1.41 1.5 1.5 0 0 0 2.12 0l2.83-2.83a1 1 0 1 0-1.41-1.41l-3.3 3.3a1 1 0 0 1-1.41 0Z"
      />
      <path
        fill="currentColor"
        d="M13.41 10.59a1 1 0 0 1 0 1.41l-3.3 3.3a3 3 0 0 1-4.24-4.24l2.83-2.83a3.5 3.5 0 0 1 4.95 0 1 1 0 0 1-1.41 1.41 1.5 1.5 0 0 0-2.12 0L7.29 11.5a1 1 0 1 0 1.41 1.41l3.3-3.3a1 1 0 0 1 1.41 0Z"
      />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm0-5a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 12 15Zm0-10a4 4 0 0 0-4 4 1 1 0 1 0 2 0 2 2 0 1 1 3.2 1.6c-.87.65-1.2 1.17-1.2 2.4a1 1 0 1 0 2 0c0-.63.14-.88.8-1.38A4 4 0 0 0 12 5Z"
      />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 21s-7-4.35-9.33-8.46C.76 9.06 2.2 5.5 5.9 4.6c1.9-.46 3.7.2 4.96 1.6 1.26-1.4 3.06-2.06 4.96-1.6 3.7.9 5.14 4.46 3.23 7.94C19 16.65 12 21 12 21Z"
      />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 2h12v2h3v4c0 3.3-2.7 6-6 6h-.2A6.02 6.02 0 0 1 13 15.66V18h4v2H7v-2h4v-2.34A6.02 6.02 0 0 1 9.2 14H9c-3.3 0-6-2.7-6-6V4h3V2Zm2 2v7c0 2.2 1.8 4 4 4s4-1.8 4-4V4H8Zm11 2h-1v5.1c1.2-.6 2-1.9 2-3.4V6ZM6 11.1V6H5v1.7c0 1.5.8 2.8 2 3.4Z"
      />
    </svg>
  );
}

function PatrolIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm-6 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm12 9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1c0-3.3 2.7-6 6-6h8c3.3 0 6 2.7 6 6Zm-2-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4h16Z"
      />
    </svg>
  );
}

export function AppHeader({ onRelink }: { onRelink?: () => void }) {
  const { user, logout } = useAuth();
  return (
    <header className="app-header">
      <Link to="/" className="app-brand">Pinewood Control</Link>
      <div className="app-header-actions">
        {onRelink ? (
          <button className="profile-btn relink-btn" onClick={onRelink} aria-label="Re-pair device">
            <span className="profile-icon" aria-hidden="true"><LinkIcon /></span>
            <span>Re-pair</span>
          </button>
        ) : null}
        <Link to="/events" className="profile-btn" aria-label="View events">
          <span className="profile-icon" aria-hidden="true"><TrophyIcon /></span>
          <span>Events</span>
        </Link>
        {user ? (
          <Link to="/patrols" className="profile-btn" aria-label="Race patrols">
            <span className="profile-icon" aria-hidden="true"><PatrolIcon /></span>
            <span>Patrols</span>
          </Link>
        ) : null}
        <button
          type="button"
          className="profile-btn"
          aria-label="Help"
          onClick={() => window.dispatchEvent(new Event(quickStartOpenEventName))}
        >
          <span className="profile-icon" aria-hidden="true"><HelpIcon /></span>
          <span>Help</span>
        </button>
        <button
          type="button"
          className="profile-btn"
          aria-label="Donate"
          onClick={() => window.dispatchEvent(new Event(donateOpenEventName))}
        >
          <span className="profile-icon" aria-hidden="true"><HeartIcon /></span>
          <span>Donate</span>
        </button>
        {user ? (
          <div className="user-nav">
            <span className="user-name">{user.name || user.email}</span>
            <button className="profile-btn" onClick={logout}>Logout</button>
          </div>
        ) : (
          <Link to="/login" className="profile-btn">Login</Link>
        )}
      </div>
    </header>
  );
}

