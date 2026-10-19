import * as React from "react";
import { cn } from "@/lib/utils";

type FieldProps = React.ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical";
};

function Field({ className, orientation = "vertical", ...props }: FieldProps) {
  return (
    <div
      className={cn(
        "flex",
        orientation === "horizontal" ? "flex-row items-center gap-2" : "flex-col gap-1.5",
        className,
      )}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn("text-[13px] font-medium text-muted-foreground whitespace-nowrap", className)}
      {...props}
    />
  );
}

export { Field, FieldLabel };
