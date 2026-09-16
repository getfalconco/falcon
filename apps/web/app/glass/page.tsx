import type { Metadata } from "next";
import GlassFullScreen from "../components/GlassFullScreen";

export const metadata: Metadata = {
  title: "Glass",
};

/**
 * The fluted glass on its own, edge to edge — a clean plate to screenshot.
 * No navbar, no copy, nothing to crop out.
 */
export default function GlassPage() {
  return <GlassFullScreen />;
}
