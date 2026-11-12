import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "./locales/en/common.json" with { type: "json" };
import hiCommon from "./locales/hi/common.json" with { type: "json" };

// Define supported languages and their display names for the application.
const DEFAULT_LANGUAGE = "en";
export const LANGUAGE_STORAGE_KEY = "nem-language";
export const supportedLanguages = ["en", "hi"];
export const languageMetadata = {
  en: { label: "English", nativeName: "English" },
  hi: { label: "Hindi", nativeName: "हिन्दी" },
};

// Load translation resources for English and Hindi.
const resources = {
  en: { translation: enCommon },
  hi: { translation: hiCommon },
};

// Safely access browser localStorage to handle environments where it is unavailable.
function getBrowserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

// Validate the selected language and use English if it is unsupported.
export function normalizeLanguage(language) {
  const candidate = (language || "").toLowerCase();
  return supportedLanguages.includes(candidate) ? candidate : DEFAULT_LANGUAGE;
}

// Retrieve the user's previously saved language preference.
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

// Save the user's language preference and apply it immediately across the application.
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

  i18next.changeLanguage(nextLanguage);
  return nextLanguage;
}

// Initialize i18next with React integration for application-wide translations.
export const i18n = i18next.use(initReactI18next);

i18n.init({
  resources,
  lng: getPreferredLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: supportedLanguages,
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

export default i18n;