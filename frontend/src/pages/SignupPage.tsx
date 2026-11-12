import type { FormEvent } from "react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AppHeader } from "../components/AppHeader";
import { api } from "../shared/api";

export function SignupPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api<{ token: string; user: { id: string; email: string; name?: string } }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, name }),
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
        <h1>Create an account</h1>
        <p className="muted">Keep your events and Race Patrols, and use them on any device.</p>
        <form onSubmit={handleSubmit} className="stack">
          <label>Name <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>Email <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button type="submit">Create Account</button>
        </form>
        <p className="auth-switch">
          {"Already have an account? "} <Link to="/login">Log in</Link>
        </p>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

