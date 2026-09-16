import { cn } from "@/lib/utils";
import { ADMIN_CARD } from "../admin-theme";

export default function AdminCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn(ADMIN_CARD, className)}>{children}</div>;
}
