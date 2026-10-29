export const uiLanguage: 'en' | 'zh';
export const uiLocale: 'en-US' | 'zh-CN';
export const englishMessages: Readonly<Record<string, string>>;
export function tr(source: string | TemplateStringsArray, ...values: unknown[]): string;
export function trc(context: string, source: string, ...values: unknown[]): string;
export function translate(source: string | TemplateStringsArray, values?: unknown[], language?: 'en' | 'zh'): string;
export function uiMessage<T>(value: T): T;
