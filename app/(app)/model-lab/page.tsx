import { requirePageScope } from "@/lib/server/session";
import { ModelLabView } from "@/components/app/model-lab-view";

export default async function ModelLabPage() {
  await requirePageScope("model_lab:read");
  return <ModelLabView />;
}
