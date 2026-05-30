import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enTranslations from './locales/en.json';
import frTranslations from './locales/fr.json';
import esTranslations from './locales/es.json';
import ptTranslations from './locales/pt.json';
import swTranslations from './locales/sw.json';
import haTranslations from './locales/ha.json';

export const SUPPORTED_LANGUAGES = {
  en: { 
    name: 'English', 
    nativeName: 'English', 
    rtl: false,
    region: 'Global',
    flag: '🇬🇧'
  },
  fr: { 
    name: 'French', 
    nativeName: 'Français', 
    rtl: false,
    region: 'West Africa',
    flag: '🇳🇪'
  },
  es: { 
    name: 'Spanish', 
    nativeName: 'Español', 
    rtl: false,
    region: 'Latin America',
    flag: '🇲🇽'
  },
  pt: { 
    name: 'Portuguese', 
    nativeName: 'Português', 
    rtl: false,
    region: 'Brazil & Angola',
    flag: '🇧🇷'
  },
  sw: { 
    name: 'Swahili', 
    nativeName: 'Kiswahili', 
    rtl: false,
    region: 'East Africa',
    flag: '🇰🇪'
  },
  ha: { 
    name: 'Hausa', 
    nativeName: 'Hausa', 
    rtl: false,
    region: 'West Africa',
    flag: '🇳🇬'
  },
} as const;

export type SupportedLanguage = keyof typeof SUPPORTED_LANGUAGES;

const resources = {
  en: { translation: enTranslations },
  fr: { translation: frTranslations },
  es: { translation: esTranslations },
  pt: { translation: ptTranslations },
  sw: { translation: swTranslations },
  ha: { translation: haTranslations },
};

/**
 * Initialize i18next with language detection and persistence
 * Detects language from localStorage first, then browser language
 * Falls back to English if no match found
 */
i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    defaultNS: 'translation',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'nova_language',
    },
  });

/**
 * Apply RTL direction to document when RTL language is selected
 */
i18next.on('languageChanged', (lng) => {
  const language = SUPPORTED_LANGUAGES[lng as SupportedLanguage];
  const htmlElement = document.documentElement;
  
  if (language?.rtl) {
    htmlElement.dir = 'rtl';
    htmlElement.lang = lng;
  } else {
    htmlElement.dir = 'ltr';
    htmlElement.lang = lng;
  }
});

// Set initial direction
const initialLng = i18next.language;
const initialLanguage = SUPPORTED_LANGUAGES[initialLng as SupportedLanguage];
if (initialLanguage?.rtl) {
  document.documentElement.dir = 'rtl';
} else {
  document.documentElement.dir = 'ltr';
}
document.documentElement.lang = initialLng;

export default i18next;
