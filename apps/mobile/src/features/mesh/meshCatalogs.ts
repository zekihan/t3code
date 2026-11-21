// The fork's copy has its own catalogs (gt.mesh.config.json), so upstream's catalogs never carry
// fork keys and stay conflict-free across rebases. Required on demand, like upstream's.
const MESH_CATALOGS: Readonly<Record<string, () => Record<string, unknown>>> = {
  es: () => require("./i18n/es.json"),
  zh: () => require("./i18n/zh.json"),
  "pt-BR": () => require("./i18n/pt-BR.json"),
  fr: () => require("./i18n/fr.json"),
  de: () => require("./i18n/de.json"),
  ja: () => require("./i18n/ja.json"),
  ko: () => require("./i18n/ko.json"),
  ru: () => require("./i18n/ru.json"),
  sv: () => require("./i18n/sv.json"),
};

/** Adds the fork's translations for `locale` to an upstream catalog. */
export function withMeshCatalog(locale: string, catalog: unknown): unknown {
  const mesh = MESH_CATALOGS[locale]?.();
  return mesh ? { ...(catalog as Record<string, unknown>), ...mesh } : catalog;
}
