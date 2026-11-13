import { Skeleton } from "@/components/ui/skeleton";

export function OptimizeItemSkeleton() {
  return <div className="batch-item" aria-hidden="true">
    <div className="item-main">
      <Skeleton className="size-[50px] shrink-0" />
      <div className="grid flex-1 gap-2 py-1"><Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>
    </div>
    <div className="item-controls"><Skeleton className="h-7 w-20" /></div>
  </div>;
}
