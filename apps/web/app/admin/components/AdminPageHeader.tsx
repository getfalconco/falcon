import { ADMIN_MONO, ADMIN_PAGE_DESC, ADMIN_PAGE_EYEBROW, ADMIN_PAGE_TITLE, ADMIN_SERIF } from "../admin-theme";

type Props = {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
};

export default function AdminPageHeader({ eyebrow, title, description, actions }: Props) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow ? (
          <p className={ADMIN_PAGE_EYEBROW} style={{ fontFamily: ADMIN_MONO }}>
            {eyebrow}
          </p>
        ) : null}
        <h1
          className={eyebrow ? `mt-1 ${ADMIN_PAGE_TITLE}` : ADMIN_PAGE_TITLE}
          style={{ fontFamily: ADMIN_SERIF, fontWeight: 400 }}
        >
          {title}
        </h1>
        {description ? <p className={ADMIN_PAGE_DESC}>{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
