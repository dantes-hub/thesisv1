import en from "../messages/en.json";
import zh from "../messages/zh.json";

const translations = { en, zh };

export function t(locale, key) {
  return translations[locale]?.[key] || key;
}
