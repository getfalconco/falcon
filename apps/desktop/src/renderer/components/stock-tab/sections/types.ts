/**
 * Every Stock tab section takes the open ticker and renders itself, fetching
 * what it needs through its own hooks. A section with nothing sourced to show
 * renders null (the tab hides empty sections), never placeholder numbers.
 */
export type StockSectionProps = { ticker: string };
