"use client";

import { useEffect, useRef, useState } from "react";

// Pixel-accurate container width via ResizeObserver, so SVG charts can
// lay out text/marks in real pixels (a stretched viewBox would distort
// text) and the crosshair math can work in the same coordinate space as
// pointer events. Returns 0 until first measure — charts render nothing
// until then (one frame).
export function useContainerWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}
