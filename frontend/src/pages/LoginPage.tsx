import type { FormEvent } from "react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AppHeader } from "../components/AppHeader";
import { api } from "../shared/api";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api<{ token: string; user: { id: string; email: string; name?: string } }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      login(res.token, res.user);
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="home-page">
      <AppHeader />
      <section className="card auth-card">
        <h1>Log in</h1>
        <p className="muted">Your events and Race Patrols, on any device.</p>
        <form onSubmit={handleSubmit} className="stack">
          <label>Email <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button type="submit">Log in</button>
        </form>
        <p className="auth-switch">
          {"No account yet? "} <Link to="/signup">Create one</Link>
        </p>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

