export function resourceHref(href: string, pathname: string) {
  if (!href.startsWith("/#")) return href;
  return pathname === "/" ? href : `/${href.slice(1)}`;
}
