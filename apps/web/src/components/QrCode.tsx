// A QR code as inline SVG: one path of dark modules with a 4-module quiet zone. Always drawn
// dark on white (light tokens, whatever the theme), which every scanner reads.
import { createMemo } from "solid-js";
import { encode } from "uqr";

export function QrCode(props: { text: string; label: string }) {
  const qr = createMemo(() => {
    const { data, size } = encode(props.text, { ecc: "M", border: 4 });
    let path = "";
    data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { path, size };
  });
  return (
    <div class="qr" data-theme="light">
      <svg
        viewBox={`0 0 ${qr().size} ${qr().size}`}
        role="img"
        aria-label={props.label}
        shape-rendering="crispEdges"
      >
        <path d={qr().path} />
      </svg>
    </div>
  );
}
