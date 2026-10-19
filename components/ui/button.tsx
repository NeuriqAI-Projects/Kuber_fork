import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium leading-none transition-colors duration-100 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        warning:
          "bg-amber-500 text-white shadow-sm hover:bg-amber-500/90",
        /** Attio's secondary button: white, 1px border, hairline shadow. */
        outline:
          "border border-input bg-field text-foreground shadow-xs hover:bg-hover",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent",
        /** Toolbar / inline actions: no chrome until hovered. */
        ghost: "text-foreground hover:bg-hover",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2.5",
        lg: "h-9 px-4 text-sm",
        icon: "size-8",
        /** Compact square icon button (toolbar controls, inline row actions) —
         *  smaller than `icon` for dense chrome like rich-text toolbars and
         *  table-row icon actions. Icon size is set on the icon itself
         *  (e.g. `size-3.5`), matching the existing `size="icon"` convention. */
        "icon-sm": "size-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
