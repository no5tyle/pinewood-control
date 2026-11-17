/*
  The qstored account signed in on this device, if any (see shared/account.ts for signing in).
*/
import React, { createContext, useContext, useEffect, useState } from "react";
import { currentSession, onSessionChange, signOut } from "./shared/account";

interface User {
  id: string;
  email: string;
  name?: string;
}

interface AuthContextType {
  user: User | null;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const userOf = (): User | null => {
  const session = currentSession();
  return session ? { id: session.uid, email: session.email } : null;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(userOf);

  useEffect(() => onSessionChange(() => setUser(userOf())), []);

  const logout = () => {
    localStorage.removeItem("pinewood_kiosk_session");
    signOut();
  };

  return <AuthContext.Provider value={{ user, logout, isLoading: false }}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
