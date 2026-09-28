import React from "react";

/**
 * PeopleWave brand logo.
 * PLACEHOLDER: inline SVG approximation. To use the official asset, replace the
 * SVG below with an <img src="/peoplewave-logo.png" .../> and drop the file into
 * each app's /public folder.
 */
export function BrandLogo({ height = 32 }: { height?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <svg
        height={height}
        viewBox="0 0 40 40"
        role="img"
        aria-label="PeopleWave logo"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="40" height="40" rx="9" fill="var(--sos-dark)" />
        <path
          d="M6 26c4-8 8-8 12 0s8 8 12 0"
          stroke="var(--sos-blue)"
          strokeWidth="3.2"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M6 20c4-8 8-8 12 0s8 8 12 0"
          stroke="var(--sos-orange)"
          strokeWidth="3.2"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <span style={{ fontWeight: 700, color: "var(--sos-dark)", fontSize: 16 }}>
        PeopleWave
      </span>
    </span>
  );
}
