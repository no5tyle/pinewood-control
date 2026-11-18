import appConfig from "../appConfig.json";

/** The address kiosk QR codes point at: VITE_QR_PREFIX if set, a LAN address in appConfig.json for local runs, else this site. */
export function getQrPrefix(): string {
  const envPrefix = import.meta.env.VITE_QR_PREFIX as string | undefined;
  if (envPrefix && envPrefix.trim().length > 0) return envPrefix.trim().replace(/\/+$/, "");

  const filePrefix = appConfig.qrPrefix?.trim();
  if (filePrefix && (window.location.hostname === "localhost" || window.location.hostname.startsWith("192.168.") || window.location.hostname.startsWith("10."))) {
    return filePrefix.replace(/\/+$/, "");
  }

  return window.location.origin.replace(/\/+$/, "");
}
