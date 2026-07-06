/**
 * App Router re-mounts a template on every route change, so this one file
 * gives every workspace module a fade-in (see .module-in in globals.css;
 * disabled under prefers-reduced-motion).
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="module-in">{children}</div>;
}
