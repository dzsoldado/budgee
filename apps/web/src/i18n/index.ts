// Every UI string goes through `t`. Adding a language means adding a dictionary next to en.json
// (and listing it in DICTIONARIES).
import en from "./en.json";
import { createTranslator } from "./translator";

export type MessageKey = keyof typeof en;

const DICTIONARIES = { en } as const;

/** Language codes that have a dictionary, for Settings → Language. */
export const LANGUAGES = Object.keys(DICTIONARIES);

export const t = createTranslator<MessageKey>(
  en,
  import.meta.env.DEV ? { warn: (message) => console.warn(message) } : {},
);
