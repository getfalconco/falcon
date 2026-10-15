import { permanentRedirect } from "next/navigation";

/**
 * Falcon's usage policy is the "Acceptable use" section of the Terms of
 * Service; this address exists so it can be linked to on its own.
 */
export default function UsagePolicyPage() {
  permanentRedirect("/terms#acceptable-use");
}
