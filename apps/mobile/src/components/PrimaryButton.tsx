import GetStartedButton from "@/components/GetStartedButton";

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Unused — kept so existing call sites keep compiling. */
  showArrow?: boolean;
  fullWidth?: boolean;
};

/**
 * Onboarding / auth CTA. Same animated pixel-arrow button as the website
 * GetStartedButton — every Continue uses this so the march stays identical.
 */
export default function PrimaryButton({
  label,
  onPress,
  disabled = false,
  fullWidth = true,
}: Props) {
  return (
    <GetStartedButton
      label={label}
      onPress={onPress}
      disabled={disabled}
      fullWidth={fullWidth}
    />
  );
}
