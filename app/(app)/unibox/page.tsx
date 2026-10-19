import { Suspense } from "react";
import { UniboxSkeleton } from "@/components/app/page-skeletons";
import { UniboxClient } from "./unibox-client";

export default function UniboxPage() {
  return (
    <Suspense fallback={<UniboxSkeleton />}>
      <UniboxClient />
    </Suspense>
  );
}
