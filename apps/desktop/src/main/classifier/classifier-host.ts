/**
 * The Classifier host moved into `@meridian/research/classifier` so the
 * always-on engine service can run the same cycle the desktop used to own.
 * Kept as a re-export: the IPC layer and the propagation host still import it
 * from here, and there is no second implementation to drift.
 */

export { ClassifierHost, getClassifierHost } from "@meridian/research/classifier";
