import { Skeleton } from "@/components/ui/skeleton";

export function GalleryCardSkeleton({ privateObject = false }: { privateObject?: boolean }) {
  return <>
    <Skeleton className="aspect-[4/3] w-full" aria-hidden="true" />
    <Skeleton className="h-4 w-1/2" aria-hidden="true" />
    <Skeleton className="h-3 w-3/4" aria-hidden="true" />
    <div className="proof-actions" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-4 w-10" />)}
    </div>
    {privateObject && <Skeleton className="h-7 w-full" aria-hidden="true" />}
  </>;
}
