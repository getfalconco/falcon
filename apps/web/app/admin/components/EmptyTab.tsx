import { Construction } from "lucide-react";
import { ADMIN_CARD, ADMIN_SHELL, ADMIN_PAGE_TITLE, ADMIN_SERIF } from "../admin-theme";

export default function EmptyTab({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className={`${ADMIN_SHELL} space-y-6`}>
      <h1
        className={ADMIN_PAGE_TITLE}
        style={{ fontFamily: ADMIN_SERIF, fontWeight: 400 }}
      >
        {title}
      </h1>
      <div className={`${ADMIN_CARD} flex flex-col items-center justify-center px-6 py-24 text-center`}>
        <span className="grid h-10 w-10 place-items-center rounded-lg border border-black/[0.08] bg-[#fbfbf9]">
          <Construction className="h-4 w-4 text-[#9a9a9a]" strokeWidth={1.75} />
        </span>
        <p className="mt-4 text-[14px] font-medium text-[#1d1b1b]">Not built yet</p>
        <p className="mt-1 max-w-sm text-[12px] leading-relaxed text-[#6b7280]">{description}</p>
      </div>
    </div>
  );
}
