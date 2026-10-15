/**
 * The invited roles that count as engine staff. Mirrors ENGINE_STAFF_ROLES in
 * packages/research/src/engine-channels.ts (the renderer cannot import the
 * research package); keep the two in sync. `talent_manager` is an invited
 * role too (it still gets its own ticket, see StaffRole in ./plans), but it
 * only runs internships, so it gets no staff controls.
 */
export const ENGINE_STAFF_ROLES = ["staff", "deputy", "leader"] as const;

/**
 * Whether an account is Falcon staff: an invited internal role in
 * `app_metadata.role` (staff, deputy, leader). app_metadata is written only
 * by the site's service role, so this cannot be self-assigned.
 *
 * The engine service makes the same decision from the verified token
 * (`isEngineStaff` in @meridian/research/engine-channels) and refuses the
 * shared switches to everyone else. This copy only decides which controls the
 * app offers; the server is what enforces it.
 */
export function isStaffAccount(appMetadata: Record<string, unknown> | null | undefined): boolean {
  const role = typeof appMetadata?.role === "string" ? appMetadata.role.trim().toLowerCase() : "";
  return (ENGINE_STAFF_ROLES as readonly string[]).includes(role);
}
