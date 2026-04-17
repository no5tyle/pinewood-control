import appConfig from "../appConfig.json";

export function getQrPrefix(): string {
  const canonical = "https://pinewood.nostyle.app";
  const envPrefix = import.meta.env.VITE_QR_PREFIX as string | undefined;
  if (envPrefix && envPrefix.trim().length > 0) {
    const normalized = envPrefix.trim().replace(/\/+$/, "");
    if (normalized === "https://nostyle.app" || normalized === "https://www.nostyle.app") return canonical;
    return normalized;
  }

  if (window.location.hostname === "nostyle.app" || window.location.hostname === "www.nostyle.app") {
    return canonical;
  }

  if (window.location.hostname === "pinewood.nostyle.app") {
    return canonical;
  }

  const filePrefix = appConfig.qrPrefix?.trim();
  if (filePrefix && (window.location.hostname === "localhost" || window.location.hostname.startsWith("192.168.") || window.location.hostname.startsWith("10."))) {
    return filePrefix.replace(/\/+$/, "");
  }

  return window.location.origin.replace(/\/+$/, "");
}

