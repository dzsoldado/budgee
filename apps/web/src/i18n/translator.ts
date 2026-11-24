export type TranslateParams = Readonly<Record<string, string | number>>;
export type Translate<K extends string> = (key: K, params?: TranslateParams) => string;

export interface TranslatorOptions {
  /** Called once per missing key (dev builds pass console.warn). */
  warn?: (message: string) => void;
}

/** `t(key, params)`: the dictionary text with `{name}` placeholders filled; the key if missing. */
export function createTranslator<K extends string>(
  dict: Readonly<Record<K, string>>,
  options: TranslatorOptions = {},
): Translate<K> {
  const warned = new Set<string>();
  return (key, params) => {
    const text = dict[key] as string | undefined;
    if (text === undefined) {
      if (options.warn && !warned.has(key)) {
        warned.add(key);
        options.warn(`Missing translation: "${key}"`);
      }
      return key;
    }
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : placeholder,
    );
  };
}
