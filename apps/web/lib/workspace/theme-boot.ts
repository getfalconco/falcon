/**
 * Shared by the /app layout (a server component) and lib/workspace/appearance.ts:
 * the last-used theme key and the inline script that applies it before the
 * first paint, so a dark theme never flashes light. Keep the script in step
 * with resolveTheme/applyTheme in appearance.ts.
 */

/** Last theme used on this browser ("system" | "light" | "dark"). */
export const THEME_LAST_KEY = "falcon.theme.last";
export const DARK_QUERY = "(prefers-color-scheme: dark)";
export const LIGHT_THEME_COLOR = "#fdfdfd";
export const DARK_THEME_COLOR = "#0d0d0d";

export const THEME_BOOT_SCRIPT = `(function(){try{var p=null;try{p=localStorage.getItem(${JSON.stringify(THEME_LAST_KEY)})}catch(e){}if(p!=="light"&&p!=="dark")p=window.matchMedia(${JSON.stringify(DARK_QUERY)}).matches?"dark":"light";var r=document.documentElement;if(p==="dark")r.classList.add("dark");else r.classList.remove("dark");r.style.colorScheme=p;r.setAttribute("data-f-theme",p);var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++)m[i].setAttribute("content",p==="dark"?${JSON.stringify(DARK_THEME_COLOR)}:${JSON.stringify(LIGHT_THEME_COLOR)})}catch(e){}})();`;
