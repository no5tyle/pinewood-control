import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

interface User {
  id: string;
  email: string;
  name?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function getApiOrigin(): string {
  const value = import.meta.env.VITE_API_ORIGIN as string | undefined;
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

const apiOrigin = getApiOrigin();

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem("auth_token"));
  const [isLoading, setIsLoading] = useState(true);

  const logout = useCallback(() => {
    localStorage.removeItem("auth_token");
    localStorage.removeItem("pinewood_kiosk_session");
    setToken(null);
    setUser(null);
  }, []);

  const login = useCallback((newToken: string, newUser: User) => {
    localStorage.setItem("auth_token", newToken);
    setToken(newToken);
    setUser(newUser);
  }, []);

  useEffect(() => {
    const fetchMe = async () => {
      if (!token) {
        setIsLoading(false);
        return;
      }

      try {
        const base = apiOrigin.length > 0 ? apiOrigin : "";
        const res = await fetch(`${base}/api/auth/me`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          cache: "no-store",
        });

        if (res.ok) {
          const userData = await res.json();
          setUser(userData);
        } else {
          logout();
        }
      } catch (error) {
        console.error("Failed to fetch user:", error);
        logout();
      } finally {
        setIsLoading(false);
      }
    };

    fetchMe();
  }, [token, logout]);

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
