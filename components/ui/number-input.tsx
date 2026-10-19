"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";

type Props = Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type" | "min" | "max"> & {
  value: number;
  onValueChange: (n: number) => void;
  min?: number;
  max?: number;
};

/**
 * A number field you can actually type into. A plain controlled number input that clamps on every
 * keystroke snaps back to its minimum the moment it is emptied, so a "1" could never be deleted to
 * type "520". Here the text is its own state: it may be empty while you type, every valid number is
 * passed up (clamped to min/max), and when you leave the field it shows the value that was kept.
 */
export function NumberInput({ value, onValueChange, min = 0, max = Number.MAX_SAFE_INTEGER, onBlur, ...rest }: Props) {
  const [text, setText] = useState(String(value));

  // The value changed from outside (a quick-pick chip, a clamp): show it, unless the box is mid-edit and empty.
  useEffect(() => {
    setText((prev) => (prev !== "" && Number(prev) !== value ? String(value) : prev));
  }, [value]);

  return (
    <Input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === "") return; // allowed while typing; the last good value stays in use
        const n = Number(t);
        if (Number.isFinite(n)) onValueChange(Math.max(min, Math.min(max, Math.round(n))));
      }}
      onBlur={(e) => { setText(String(value)); onBlur?.(e); }}
    />
  );
}
