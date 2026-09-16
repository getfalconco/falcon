"use client";

import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import ApplicationFlow, {
  type ApplicationCredentials,
} from "./ApplicationFlow";
import { TierGrid } from "./TierTickets";

/**
 * The early-access ticket plus the application it opens into. The ticket stage
 * only collects credentials; the questionnaire that follows is what actually
 * creates the waitlist entry.
 */
export default function EarlyAccessApply({
  stageHeading,
  stageParagraphs,
  stageStep2,
}: {
  stageHeading: string;
  stageParagraphs: string[];
  stageStep2: { intro: string; paragraphs: string[] };
}) {
  const [credentials, setCredentials] = useState<ApplicationCredentials | null>(
    null,
  );

  return (
    <>
      <TierGrid
        firstName="John"
        lastName="Doe"
        tierKeys={["early"]}
        showBilling={false}
        showComparison={false}
        showPrice={false}
        showRules={false}
        ticketWidth={400}
        stageHeading={stageHeading}
        stageParagraphs={stageParagraphs}
        stageStep2={stageStep2}
        onApply={setCredentials}
      />

      <AnimatePresence>
        {credentials ? (
          <ApplicationFlow
            credentials={credentials}
            onClose={() => setCredentials(null)}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}
