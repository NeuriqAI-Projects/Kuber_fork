"use client";

import dynamic from "next/dynamic";
import { SettingsSkeleton } from "@/components/app/page-skeletons";

const CreditsView = dynamic(
  () => import("@/components/app/credits-view").then((m) => m.CreditsView),
  { loading: () => <SettingsSkeleton /> },
);

export default function CreditsPage() {
  return <CreditsView />;
}
