"use client"

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger
const PopoverAnchor = PopoverPrimitive.Anchor

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  onWheel,
  onTouchMove,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        // A popover opened inside a modal Dialog is portaled OUTSIDE the dialog, and the dialog's
        // scroll lock swallows every wheel/touch event outside itself, so a long list could not be
        // scrolled with the mouse wheel. Stopping the event here keeps it from reaching that lock.
        onWheel={(e) => { e.stopPropagation(); onWheel?.(e); }}
        onTouchMove={(e) => { e.stopPropagation(); onTouchMove?.(e); }}
        className={cn(
          "z-50 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
