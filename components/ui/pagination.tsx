import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      role="navigation"
      aria-label="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  );
}

function PaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul className={cn("flex flex-row items-center gap-1", className)} {...props} />
  );
}

function PaginationItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li className={cn("", className)} {...props} />;
}

type PaginationLinkProps = {
  isActive?: boolean;
  disabled?: boolean;
} & React.ComponentProps<"button">;

function PaginationLink({ className, isActive, disabled, ...props }: PaginationLinkProps) {
  return (
    <button
      type="button"
      aria-current={isActive ? "page" : undefined}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center size-7 rounded-md border border-transparent text-[13px] font-medium tabular-nums text-muted-foreground transition-colors",
        "hover:bg-hover hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-40",
        isActive && "border-border bg-field text-foreground shadow-xs",
        className,
      )}
      {...props}
    />
  );
}

function PaginationPrevious({ className, ...props }: React.ComponentProps<"button"> & { disabled?: boolean }) {
  return (
    <PaginationLink
      aria-label="Go to previous page"
      className={cn("gap-1 px-2.5", className)}
      {...props}
    >
      <ChevronLeft className="size-4" />
    </PaginationLink>
  );
}

function PaginationNext({ className, ...props }: React.ComponentProps<"button"> & { disabled?: boolean }) {
  return (
    <PaginationLink
      aria-label="Go to next page"
      className={cn("gap-1 px-2.5", className)}
      {...props}
    >
      <ChevronRight className="size-4" />
    </PaginationLink>
  );
}

function PaginationEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      className={cn("flex size-8 items-center justify-center text-muted-foreground text-sm", className)}
      {...props}
    >
      …
    </span>
  );
}

export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
};
