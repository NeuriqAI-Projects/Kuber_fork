"use client";

import { useEffect } from "react";

/**
 * Esc closes only this hand-made dropdown, not the dialog it sits in.
 *
 * Radix dialogs listen for Esc on `document` in the capture phase, so a React onKeyDown (or a
 * document listener) inside the dropdown always comes too late: the whole wizard closed. A
 * capture listener on `window` runs before the document's, so it can stop the event there.
 * An open Radix list inside the dropdown (e.g. a Select's options) is left to close itself first.
 */
export function useEscClose(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[role="listbox"][data-state="open"], [role="menu"][data-state="open"]')) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);
}
