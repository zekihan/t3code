export const MESH_DOMAIN = "mesh.noqer.com";
export const MESH_HUB_URL = `https://hub.${MESH_DOMAIN}`;
export const MESH_MACHINES_URL = `${MESH_HUB_URL}/api/v1/machines`;

// A DNS label of lowercase letters, digits and inner hyphens. The machine name is the label.
const SAFE_MACHINE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The origin `https://t3.<name>.mesh.noqer.com` when `viewerUrl` is exactly that, or null.
 * It is matched as text, never parsed leniently: the origin receives the hub's certificate.
 * Only one trailing slash is accepted.
 */
export function meshViewerOrigin(name: unknown, viewerUrl: unknown): string | null {
  if (typeof name !== "string" || typeof viewerUrl !== "string") return null;
  if (!SAFE_MACHINE_NAME.test(name)) return null;
  const origin = `https://t3.${name}.${MESH_DOMAIN}`;
  return viewerUrl === origin || viewerUrl === `${origin}/` ? origin : null;
}
