/**
 * Priced-in arithmetic — one definition, in the engine.
 *
 * This used to be a hand-kept copy of the engine's own arithmetic so the
 * renderer would not pull Node-only code into the Vite bundle. The engine now
 * publishes the pure half of itself as `@meridian/research/propagation/contracts`
 * (types and functions over plain run data, no fs and no network), so the copy
 * is gone and both sides read the same source.
 */

export {
  livePricedIn,
  runAbsorption,
  runPricedIn,
  targetPricedIn,
  targetProgress,
} from "@meridian/research/propagation/contracts";
