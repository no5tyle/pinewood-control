import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { BackendStatusBanner } from "./BackendStatusBanner";
import { quickStartOpenEventName } from "../shared/events";

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

function SetupsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 6h9.2a3 3 0 0 1 5.6 0H20a1 1 0 1 1 0 2h-1.2a3 3 0 0 1-5.6 0H4a1 1 0 0 1 0-2Zm12 1a1 1 0 1 0 0 .01V7ZM4 16h1.2a3 3 0 0 1 5.6 0H20a1 1 0 1 1 0 2h-9.2a3 3 0 0 1-5.6 0H4a1 1 0 1 1 0-2Zm4 1a1 1 0 1 0 0 .01V17Z"
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

/** The app's mark: the car from the favicon on a navy tile, as no5tyle's other apps have */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="120" fill="#052767" />
      <g transform="translate(51 51) scale(.8)">
        <path
          fill="#fff"
          d="M408.29 262.879a35.125 35.125 0 1 0 35.125 35.125 35.17 35.17 0 0 0-35.125-35.125zm0 62.873a27.736 27.736 0 1 1 27.736-27.737 27.736 27.736 0 0 1-27.736 27.748zm8.876-27.737a8.876 8.876 0 1 1-8.876-8.875 8.876 8.876 0 0 1 8.876 8.875zm-265.538 0a35.125 35.125 0 1 0-35.126 35.126 35.17 35.17 0 0 0 35.126-35.126zm-35.126 27.737a27.736 27.736 0 1 1 27.737-27.737 27.736 27.736 0 0 1-27.737 27.748zm345.452-21.823a53.997 53.997 0 1 0-107.617-5.925 53.665 53.665 0 0 0 5.447 23.61H165.008a53.986 53.986 0 1 0-101.849-15.211C37.542 295.64 21 278.033 21 250.186c0-28.846 86.87-69.418 142.122-71.327v34.094a24.83 24.83 0 0 0 24.83 24.83h47.517a24.774 24.774 0 0 0 24.409-20.758s-1.62-21.668-6.813-25.518l3.407-2.54 24.474 28.08h94.104c63.994-.022 115.95 23.42 115.95 52.266 0 13.314-10.973 25.396-29.046 34.616zm-336.576-5.925a8.876 8.876 0 1 1-8.876-8.876 8.876 8.876 0 0 1 8.876 8.887z"
        />
      </g>
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M4 6.5h16v2H4zm0 4.5h16v2H4zm0 4.5h16v2H4z" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-8v-2h8V6h-8V4Zm-1.6 3.6L9.8 9l-2 2H16v2H7.8l2 2-1.4 1.4L4 12l4.4-4.4Z"
      />
    </svg>
  );
}

/** Up to two letters for the profile button: "Sam Leader" is SL */
function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts
    .filter((_, i) => i === 0 || i === parts.length - 1)
    .map((part) => part[0].toUpperCase())
    .join("");
}

/*
  The bar across the top of every page, in the look Pinewood Control shares with no5tyle's other apps.
  On a computer: the app's name, the pages, and a profile menu at the right with Logout. On a phone:
  the name and one menu button holding everything. On the kiosk (onRelink given) it shrinks to a small
  glass capsule in the corner, out of the way of the big screen.
*/
export function AppHeader({ onRelink }: { onRelink?: () => void }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const kiosk = Boolean(onRelink);
  const displayName = user ? user.name || user.email : "";

  // Close the menu on moving to another page, or with Escape
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const openHelp = () => {
    setMenuOpen(false);
    window.dispatchEvent(new Event(quickStartOpenEventName));
  };

  const pages = (
    <>
      <NavLink to="/events" className="nav-link">
        <TrophyIcon />
        <span>Events</span>
      </NavLink>
      {user ? (
        <NavLink to="/patrols" className="nav-link">
          <PatrolIcon />
          <span>Patrols</span>
        </NavLink>
      ) : null}
      {user ? (
        <NavLink to="/setups" className="nav-link">
          <SetupsIcon />
          <span>Setups</span>
        </NavLink>
      ) : null}
      <button type="button" className="nav-link" onClick={openHelp}>
        <HelpIcon />
        <span>Help</span>
      </button>
    </>
  );

  return (
    <div className={`app-header-wrap ${kiosk ? "kiosk" : ""}`}>
      <header className="app-header">
        {/* The switcher between no5tyle's apps (no5tyle.github.io/shared/app-switcher.js); the mark shows until it loads */}
        <n5-app-switcher current="pinewood">
          <BrandMark />
        </n5-app-switcher>
        <Link to="/" className="app-brand" aria-label="Pinewood Control home">
          <span className="brand-text">
            <span className="brand-title">Pinewood Control</span>
            <span className="brand-sub">Race night for pinewood derbies</span>
          </span>
        </Link>

        <nav className="app-nav" aria-label="Main">
          {pages}
        </nav>

        <div className="app-header-actions">
          {onRelink ? (
            <button type="button" className="relink-btn" onClick={onRelink} aria-label="Re-pair device">
              <LinkIcon />
              <span>Re-pair</span>
            </button>
          ) : null}
          {!user ? (
            <Link to="/login" className="login-btn">
              Log in
            </Link>
          ) : null}
          <button
            type="button"
            className={`menu-btn ${user ? "has-user" : "no-user"}`}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-label={user ? `Menu: ${displayName}` : "Menu"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {user ? (
              <>
                <span className="avatar" aria-hidden="true">
                  {initialsOf(displayName) || "?"}
                </span>
                <span className="menu-name">{displayName}</span>
              </>
            ) : (
              <MenuIcon />
            )}
          </button>
          {menuOpen ? (
            <>
              <button type="button" className="menu-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)} />
              <div className="app-menu" role="menu">
                {user ? (
                  <div className="menu-who">
                    <strong>{user.name || user.email}</strong>
                    {user.name ? <span>{user.email}</span> : null}
                  </div>
                ) : null}
                <div className="menu-pages">{pages}</div>
                {user ? (
                  <button
                    type="button"
                    className="nav-link"
                    onClick={() => {
                      setMenuOpen(false);
                      logout();
                    }}
                  >
                    <LogoutIcon />
                    <span>Log out</span>
                  </button>
                ) : (
                  <>
                    <NavLink to="/login" className="nav-link">
                      <LogoutIcon />
                      <span>Log in</span>
                    </NavLink>
                    <NavLink to="/signup" className="nav-link">
                      <PatrolIcon />
                      <span>Sign up</span>
                    </NavLink>
                  </>
                )}
              </div>
            </>
          ) : null}
        </div>
      </header>
      <BackendStatusBanner />
    </div>
  );
}
