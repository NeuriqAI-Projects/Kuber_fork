"use client";

import { Flame, Snowflake } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { temperatureBadge } from "@/lib/temperature-badge";

type Props = {
  temperature: string | null | undefined;
  className?: string;
};

const ICONS: Partial<Record<string, React.ReactNode>> = {
  hot: <Flame className="size-3" />,
  cold: <Snowflake className="size-3" />,
};

/** The shared map labels are upper case ("OUT OF OFFICE"); tags read in sentence case. */
export function temperatureLabel(temperature: string | null | undefined): string {
  const { label } = temperatureBadge(temperature);
  return label.charAt(0) + label.slice(1).toLowerCase();
}

export function UniboxTemperatureBadge({ temperature, className }: Props) {
  const badge = temperatureBadge(temperature);
  const icon = ICONS[temperature ?? ""] ?? null;

  return (
    <Badge variant="outline" className={cn("shrink-0 gap-1", badge.cls, className)}>
      {icon}
      {temperatureLabel(temperature)}
    </Badge>
  );
}
