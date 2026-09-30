import React from "react";
import fullLogo from "./assets/peoplewave-logo.png";
import compactLogo from "./assets/peoplewave-logo-compact.png";

/**
 * Official PeopleWave logo (transparent PNGs made from the brand artwork).
 *
 * - "compact" (default): icon + wordmark, for headers and other small spots.
 * - "full": adds the "Building smarter enterprises, together." tagline. Use it
 *   at 48px tall or more; below that the tagline is not legible.
 *
 * Intrinsic sizes go in the width/height attributes so the layout doesn't
 * shift while the image loads; maxWidth lets it shrink in narrow containers.
 */
const LOGOS = {
  compact: { src: compactLogo, width: 514, height: 68, alt: "PeopleWave" },
  full: { src: fullLogo, width: 563, height: 92, alt: "PeopleWave — Building smarter enterprises, together." },
} as const;

export function BrandLogo({ height = 26, variant = "compact" }: { height?: number; variant?: keyof typeof LOGOS }) {
  const logo = LOGOS[variant];
  return (
    <img
      src={logo.src}
      alt={logo.alt}
      width={Math.round((height * logo.width) / logo.height)}
      height={height}
      draggable={false}
      style={{ display: "inline-block", verticalAlign: "middle", maxWidth: "100%", height: "auto", flexShrink: 0 }}
    />
  );
}
