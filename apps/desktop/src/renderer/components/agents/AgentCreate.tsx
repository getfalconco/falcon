/**
 * New agent used to be a screen of its own beside the list. Both ways into
 * creating an agent now open the same two-step Create Agent modal
 * (AgentWizard.tsx): the empty tab, and New agent from a tab that has some.
 * This name is kept so an import of it still lands on that modal.
 */
export { default } from "./AgentWizard";
