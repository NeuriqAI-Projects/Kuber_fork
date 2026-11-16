import { Suspense } from "react";
import { UniboxSkeleton } from "@/components/app/page-skeletons";
import { requirePageScope } from "@/lib/server/session";
import { UniboxClient } from "./unibox-client";

export default async function UniboxPage() {
  await requirePageScope("unibox:read");
  return (
    <Suspense fallback={<UniboxSkeleton />}>
      <UniboxClient />
    </Suspense>
  );
}
