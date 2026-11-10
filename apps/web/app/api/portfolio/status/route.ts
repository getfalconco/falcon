import { NextResponse } from "next/server";
import { portfolioSources } from "@/lib/portfolio-server";

export const dynamic = "force-dynamic";

/**
 * Which ways of connecting a portfolio this deployment can offer, so the
 * welcome flow can show the others as coming soon. Only true/false is sent.
 *
 *   GET /api/portfolio/status -> 200 { screenshot, broker }
 */
export function GET() {
  return NextResponse.json(portfolioSources(), { headers: { "Cache-Control": "no-store" } });
}
