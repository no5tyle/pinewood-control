import { useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";

export function AuthRequiredPage({ message }: { message?: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();

  return (
    <main className="home-page auth-required-page">
      <section className="card auth-required-card">
        <h1>Authentication Required</h1>
        <p className="muted">
          {user
            ? "This event is owned by a different account, or your access has expired."
            : "This event is owned by an account. Login to access it if it’s yours, or return to Events."}
        </p>
        {message ? <p className="muted">{message}</p> : null}
        <div className="auth-required-actions">
          <button className="secondary-btn" onClick={() => navigate("/")}>Home</button>
          {!user ? <button onClick={() => navigate("/login")}>Login</button> : null}
        </div>
      </section>
    </main>
  );
}

