import fs from "node:fs/promises";
import path from "node:path";

type TranslationRulesConfig = Record<string, string[]>;

function normalizeLanguageCode(language: string): string {
  return language.trim().toLowerCase().replace(/_/g, "-");
}

function validateConfig(value: unknown, filePath: string): TranslationRulesConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Translation rules file must contain a JSON object: ${filePath}`);
  }

  const config: TranslationRulesConfig = {};
  for (const [language, rules] of Object.entries(value)) {
    if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string")) {
      throw new Error(
        `Translation rules for "${language}" must be an array of strings: ${filePath}`,
      );
    }

    const normalizedLanguage = normalizeLanguageCode(language);
    if (!normalizedLanguage) {
      throw new Error(`Translation rules contain an empty language code: ${filePath}`);
    }

    config[normalizedLanguage] = rules.map((rule) => rule.trim()).filter(Boolean);
  }

  return config;
}

export async function loadTranslationRules(
  rulesFile: string,
  targetLanguage: string,
): Promise<string[]> {
  const absolutePath = path.resolve(rulesFile);
  let raw: string;

  try {
    raw = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "ENOENT") {
      throw new Error(`Translation rules file not found: ${absolutePath}`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Translation rules file is not valid JSON: ${absolutePath}`);
  }

  const config = validateConfig(parsed, absolutePath);
  const normalizedTarget = normalizeLanguageCode(targetLanguage);
  const baseLanguage = normalizedTarget.split("-")[0];
  const languageKeys =
    baseLanguage === normalizedTarget ? [baseLanguage] : [baseLanguage, normalizedTarget];

  return Array.from(new Set(languageKeys.flatMap((language) => config[language] ?? [])));
}
