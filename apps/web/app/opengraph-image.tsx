import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Falcon — Institutional market research for individual traders";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          backgroundColor: "#090909",
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "20px",
            marginBottom: "48px",
          }}
        >
          <div
            style={{
              width: "48px",
              height: "48px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "linear-gradient(135deg, rgba(255,255,255,0.25), rgba(255,255,255,0.05))",
              border: "1px solid rgba(255,255,255,0.2)",
            }}
          >
            <div
              style={{
                width: "16px",
                height: "16px",
                backgroundColor: "rgba(255,255,255,0.8)",
              }}
            />
          </div>
          <span style={{ fontSize: "22px", color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em" }}>
            FALCON
          </span>
        </div>

        <div
          style={{
            fontSize: "72px",
            fontFamily: "Georgia, serif",
            fontWeight: 400,
            color: "#ffffff",
            lineHeight: 1.1,
            letterSpacing: "-0.01em",
            maxWidth: "900px",
          }}
        >
          Institutional market research
        </div>

        <div
          style={{
            marginTop: "24px",
            fontSize: "32px",
            color: "#707070",
            lineHeight: 1.4,
          }}
        >
          For individual traders
        </div>
      </div>
    ),
    { ...size },
  );
}
