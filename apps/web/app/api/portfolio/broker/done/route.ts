export const dynamic = "force-dynamic";

/**
 * SnapTrade's Connection Portal redirects here when the member is done. The
 * page tells the welcome flow (its opener, same origin only) and closes.
 */
export function GET(request: Request) {
  const status = new URL(request.url).searchParams.get("status") ?? "";
  const ok = !/error|fail|abandon|cancel/i.test(status);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Falcon</title>
<style>body{margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#fdfdfd;color:#1d1b1b;font:14px/1.5 system-ui,sans-serif}</style>
</head>
<body>
<p>You can close this window and go back to Falcon.</p>
<script>
(function () {
  try {
    if (window.opener) {
      window.opener.postMessage({ type: "falcon:broker", ok: ${ok ? "true" : "false"} }, window.location.origin);
    }
  } catch (e) {}
  setTimeout(function () { window.close(); }, 150);
})();
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
