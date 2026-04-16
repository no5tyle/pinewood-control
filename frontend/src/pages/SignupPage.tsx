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
      <section className="card" style={{ maxWidth: "400px", margin: "2rem auto" }}>
        <h1>Sign Up</h1>
        <form onSubmit={handleSubmit} className="stack">
          <label>Name <input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button type="submit">Create Account</button>
        </form>
        <p style={{ marginTop: "1rem", textAlign: "center" }}>
          {"Already have an account? "} <Link to="/login">Login</Link>
        </p>
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}

