import { ShaderBackground, type ShaderColor } from "@/components/ui/fluted-glass-folds";

type Props = {
  showTestimonials?: boolean;
};

// Turkish blue: bright turquoise → deep teal → near-black, with a pale-blue tip.
// Matches the marketing homepage's Fluted Glass palette.
const TURKISH_BLUE: ShaderColor[] = [
  [0.31, 0.847, 0.902], // #4fd8e6
  [0.059, 0.49, 0.573], // #0f7d92
  [0.02, 0.149, 0.184], // #05262f
  [0.435, 0.867, 0.933], // #6fddee
];

export default function AnimatedGradientPanel(_: Props) {
  return (
    <div className="app-drag-region relative h-full overflow-hidden">
      <ShaderBackground className="absolute inset-0" colors={TURKISH_BLUE} colorCount={4} />
    </div>
  );
}
