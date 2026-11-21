import { gtFallback } from "gt-react-native";
import { describe, expect, it } from "vite-plus/test";

import de from "./i18n/de.json";
import en from "./i18n/en.json";
import es from "./i18n/es.json";
import fr from "./i18n/fr.json";
import ja from "./i18n/ja.json";
import ko from "./i18n/ko.json";
import ptBR from "./i18n/pt-BR.json";
import ru from "./i18n/ru.json";
import sv from "./i18n/sv.json";
import zh from "./i18n/zh.json";
import { withMeshCatalog } from "./meshCatalogs";

const SOURCE: Record<string, unknown> = en;
const LOCALES: Record<string, Record<string, unknown>> = {
  es,
  zh,
  "pt-BR": ptBR,
  fr,
  de,
  ja,
  ko,
  ru,
  sv,
};

const variableNames = (text: string) =>
  [...new Set([...text.matchAll(/\{(\w+)[,}]/g)].map((match) => match[1]))].toSorted();

const jsxSlots = (entry: readonly unknown[]) =>
  entry.filter((item) => typeof item !== "string").map((item) => JSON.stringify(item));

describe("mesh catalogs", () => {
  it.each(Object.entries(LOCALES))("%s has exactly the source keys", (_locale, catalog) => {
    expect(Object.keys(catalog).toSorted()).toEqual(Object.keys(SOURCE).toSorted());
  });

  it.each(Object.entries(LOCALES))("%s keeps every variable and JSX slot", (_locale, catalog) => {
    for (const [key, source] of Object.entries(SOURCE)) {
      const target = catalog[key];
      if (typeof source === "string") {
        expect(typeof target, key).toBe("string");
        expect(variableNames(target as string), key).toEqual(variableNames(source));
      } else {
        expect(Array.isArray(target), key).toBe(true);
        expect(jsxSlots(target as unknown[]).toSorted(), key).toEqual(
          jsxSlots(source as unknown[]).toSorted(),
        );
      }
    }
  });

  it.each(Object.entries(LOCALES))("%s formats every message", (locale, catalog) => {
    for (const [key, source] of Object.entries(SOURCE)) {
      const target = catalog[key];
      if (typeof source !== "string" || typeof target !== "string") continue;
      const values = Object.fromEntries(variableNames(source).map((name) => [name, 2]));
      expect(gtFallback(target, { ...values, $locale: locale }), key).not.toMatch(/[{}]/);
    }
  });

  it("adds the fork's keys to an upstream catalog", () => {
    const merged = withMeshCatalog("de", { upstream: "Upstream" }) as Record<string, unknown>;
    expect(merged.upstream).toBe("Upstream");
    expect(Object.keys(merged)).toHaveLength(Object.keys(SOURCE).length + 1);
    expect(withMeshCatalog("en", { upstream: "Upstream" })).toEqual({ upstream: "Upstream" });
  });
});
