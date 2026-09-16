/**
 * Desktop wiring for the Analyst host.
 *
 * The host moved into `@meridian/research/analyst` so the always-on engine
 * service can run it against the Tracker that is actually being polled. What
 * stays here is nothing but this re-export — the host pushes nothing.
 *
 * Importers keep this path; there is no second implementation to drift.
 */


export { AnalystHost, getAnalystHost } from "@meridian/research/analyst";
