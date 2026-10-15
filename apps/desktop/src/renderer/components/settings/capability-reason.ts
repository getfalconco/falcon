import type { Capability } from "../../../shared/system-settings";
import type { MessageKey, TFunction } from "@/lib/i18n";

/** Why a switch cannot be used here, by the code main sends; its English if the code is new. */
const CAPABILITY_KEYS: Readonly<Record<string, MessageKey>> = {
  "installed-only": "settings.system.reason.installedOnly",
  "unsupported-platform": "settings.system.reason.unsupported",
  "updates-installed-only": "settings.system.reason.updatesInstalledOnly",
  "data-root-env": "system.folder.envSet",
};

/** The line under a row whose control main says this build cannot use; undefined when it can. */
export function capabilityReason(capability: Capability, t: TFunction): string | undefined {
  if (capability.supported) return undefined;
  const key = capability.code ? CAPABILITY_KEYS[capability.code] : undefined;
  return key ? t(key) : capability.reason;
}
