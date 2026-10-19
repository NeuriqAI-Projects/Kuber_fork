import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Compact rounded chip — used both via <Badge> and via badgeVariants() on
// removable filter tokens (countries, keywords, titles). Shape + centering
// live here so every selected-filter pill matches.
const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1 rounded-[5px] border px-1.5 py-[3px] text-[11px] leading-none font-medium whitespace-nowrap transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive/10 text-destructive",
        outline: "border-border bg-field text-foreground",
        /** A chosen value — selected filter chips, removable tokens, active toggles. */
        selected: "border-transparent bg-primary/10 text-primary",
        /** The unselected half of a toggle pair; pairs with `selected`. */
        unselected:
          "border-border text-muted-foreground hover:bg-hover hover:text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {children}
    </span>
  )
}

export { Badge, badgeVariants }
