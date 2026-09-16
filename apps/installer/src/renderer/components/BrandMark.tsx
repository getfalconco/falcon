import falconMark from "@/assets/brand/logo-black.png";

/**
 * The falcon mark, tinted rather than painted: the PNG is used as a mask so the
 * glyph takes whatever color it is given. Same technique as the site's navbar,
 * which is how the mark stays exactly the ink of the text beside it.
 */
export default function BrandMark({
  className = "",
  color = "rgb(29, 27, 27)",
}: {
  className?: string;
  color?: string;
}) {
  return (
    <span
      role="img"
      aria-label="Falcon"
      className={`block ${className}`}
      style={{
        backgroundColor: color,
        WebkitMaskImage: `url(${falconMark})`,
        maskImage: `url(${falconMark})`,
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}
