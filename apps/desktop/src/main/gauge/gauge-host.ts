/**
 * Desktop wiring for the Gauge host.
 *
 * The host moved into `@meridian/research/gauge` so the always-on engine
 * service can run it against the Tracker that is actually being polled. What
 * stays here is nothing but this re-export — the host pushes nothing.
 *
 * Importers keep this path; there is no second implementation to drift.
 */


export { GaugeHost, getGaugeHost } from "@meridian/research/gauge";
