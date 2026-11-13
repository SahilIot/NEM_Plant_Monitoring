import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "./locales/en/common.json" with { type: "json" };
import hiCommon from "./locales/hi/common.json" with { type: "json" };

const DEFAULT_LANGUAGE = "en";
export const LANGUAGE_STORAGE_KEY = "nem-language";

export const languageMetadata = {
  en: { label: "English", nativeName: "English" },
  hi: { label: "Hindi", nativeName: "हिन्दी" },
};

export const futureLanguageMetadata = {
  pa: { label: "Punjabi", nativeName: "ਪੰਜਾਬੀ" },
  fr: { label: "French", nativeName: "Français" },
  de: { label: "German", nativeName: "Deutsch" },
  es: { label: "Spanish", nativeName: "Español" },
};

export let supportedLanguages = ["en", "hi"];

export const availableLanguages = { ...languageMetadata };

const resources = {
  en: { translation: enCommon },
  hi: { translation: hiCommon },
};

export function registerLanguage(languageCode, languageConfig = {}) {
  const code = String(languageCode || "").trim().toLowerCase();
  if (!code) return null;

  const metadata = {
    label: languageConfig.label || code,
    nativeName: languageConfig.nativeName || languageConfig.label || code,
  };

  if (!supportedLanguages.includes(code)) {
    supportedLanguages.push(code);
  }

  languageMetadata[code] = metadata;
  resources[code] = { translation: languageConfig.translations || {} };
  return code;
}

function getBrowserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function normalizeLanguage(language) {
  const raw = (language ?? "").toString().trim();
  if (!raw) return DEFAULT_LANGUAGE;

  const normalized = raw.toLowerCase().replace(/_/g, "-");
  const candidate = normalized.split("-")[0];
  const available = new Set(supportedLanguages);

  return available.has(candidate) ? candidate : DEFAULT_LANGUAGE;
}

export function getPreferredLanguage() {
  const storage = getBrowserStorage();
  if (!storage) return DEFAULT_LANGUAGE;

  try {
    const savedLanguage = storage.getItem(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(savedLanguage);
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function setPreferredLanguage(language) {
  const nextLanguage = normalizeLanguage(language);
  const storage = getBrowserStorage();

  if (storage) {
    try {
      storage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
    } catch {
      // Continue with the in-memory language if localStorage is unavailable.
    }
  }

  if (typeof document !== "undefined") {
    document.documentElement.lang = nextLanguage;
    document.documentElement.setAttribute("data-locale", nextLanguage);
  }

  i18next.changeLanguage(nextLanguage);
  return nextLanguage;
}

export const i18n = i18next.use(initReactI18next);

i18n.init({
  resources,
  lng: getPreferredLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...new Set(supportedLanguages)],
  ns: ["translation"],
  defaultNS: "translation",
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
  react: {
    useSuspense: false,
  },
});

if (typeof document !== "undefined") {
  document.documentElement.lang = i18n.resolvedLanguage || getPreferredLanguage();
}

export default i18n;