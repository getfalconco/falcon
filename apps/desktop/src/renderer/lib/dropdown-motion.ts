/**
 * How every dropdown on the dashboard opens and closes: a fade, and nothing
 * else. The menus used to grow out of their button with a spring, scaling up
 * and sliding down a few pixels; they now appear where they will stay and
 * only their opacity moves. One constant, spread onto each menu's
 * `motion.div`, so a menu written later opens the same way without anyone
 * having to copy four props.
 */
export const DROPDOWN_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.14, ease: "easeOut" },
} as const;
