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
      <section className="card" style={{ maxWidth: "400px", margin: "2rem auto" }}>
        <h1>Login</h1>
        <form onSubmit={handleSubmit} className="stack">
          <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button type="submit">Login</button>
        </form>
        <p style={{ marginTop: "1rem", textAlign: "center" }}>
          {"Don't have an account? "} <Link to="/signup">Sign up</Link>
        </p>
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}

