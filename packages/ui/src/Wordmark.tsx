type Props = {
  className?: string;
};

export default function Wordmark({ className = "" }: Props) {
  return (
    <span
      className={`text-[19px] font-semibold tracking-tight text-ink ${className}`}
    >
      Falcon
    </span>
  );
}
